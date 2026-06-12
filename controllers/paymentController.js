const crypto = require('crypto');
const Razorpay = require('razorpay');
const { query, transaction } = require('../config/db');

const PLAN_CATALOG = {
  Starter: {
    monthly: {
      amount: 900,
      currency: 'USD',
      durationDays: 30,
      description: 'Starter monthly subscription',
    },
    yearly: {
      amount: 9000,
      currency: 'USD',
      durationDays: 365,
      description: 'Starter yearly subscription',
    },
  },
  Growth: {
    monthly: {
      amount: 2900,
      currency: 'USD',
      durationDays: 30,
      description: 'Growth monthly subscription',
    },
    yearly: {
      amount: 29000,
      currency: 'USD',
      durationDays: 365,
      description: 'Growth yearly subscription',
    },
  },
};

const getCatalogPrice = (planName, billingPeriod = 'monthly') => {
  const plan = PLAN_CATALOG[planName];
  if (!plan) return null;
  return plan[billingPeriod] || null;
};

const getRazorpayClient = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay credentials are not configured.');
  }

  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const getPlans = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, price, max_leads, max_staff
       FROM plans
       WHERE is_active = true
       ORDER BY price ASC`
    );

    const plans = result.rows.map((plan) => {
      const catalogPlan = PLAN_CATALOG[plan.name];
      return {
        ...plan,
        checkoutEnabled: Boolean(catalogPlan),
        prices: catalogPlan || null,
        amount: catalogPlan?.monthly?.amount || Number(plan.price) * 100,
        currency: catalogPlan?.monthly?.currency || 'USD',
      };
    });

    res.json({ plans, razorpayKeyId: process.env.RAZORPAY_KEY_ID || null });
  } catch (error) {
    console.error('Get payment plans error:', error);
    res.status(500).json({ error: 'Failed to load payment plans.' });
  }
};

const createOrder = async (req, res) => {
  try {
    const { planName, billingPeriod = 'monthly' } = req.body;
    const selectedPlan = getCatalogPrice(planName, billingPeriod);

    if (!selectedPlan) {
      return res.status(400).json({ error: 'Online checkout is available for Starter and Growth monthly or yearly plans only.' });
    }

    const planResult = await query('SELECT id, name FROM plans WHERE name = $1 AND is_active = true', [planName]);
    const plan = planResult.rows[0];

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found.' });
    }

    const razorpay = getRazorpayClient();
    const receipt = `tenant_${req.tenantId.slice(0, 8)}_${Date.now()}`;
    const order = await razorpay.orders.create({
      amount: selectedPlan.amount,
      currency: selectedPlan.currency,
      receipt,
      notes: {
        tenant_id: req.tenantId,
        plan_id: plan.id,
        plan_name: plan.name,
        billing_period: billingPeriod,
      },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      plan: {
        id: plan.id,
        name: plan.name,
        description: selectedPlan.description,
        billingPeriod,
      },
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      prefill: {
        name: req.user.name,
        email: req.user.email,
      },
    });
  } catch (error) {
    console.error('Create Razorpay order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create payment order.' });
  }
};

const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName, billingPeriod = 'monthly' } = req.body;
    const selectedPlan = getCatalogPrice(planName, billingPeriod);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !selectedPlan) {
      return res.status(400).json({ error: 'Invalid payment verification payload.' });
    }

    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Razorpay secret is not configured.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment signature verification failed.' });
    }

    const razorpay = getRazorpayClient();
    const [order, payment] = await Promise.all([
      razorpay.orders.fetch(razorpay_order_id),
      razorpay.payments.fetch(razorpay_payment_id),
    ]);

    if (
      order.amount !== selectedPlan.amount ||
      order.currency !== selectedPlan.currency ||
      order.notes?.tenant_id !== req.tenantId ||
      order.notes?.plan_name !== planName ||
      order.notes?.billing_period !== billingPeriod
    ) {
      return res.status(400).json({ error: 'Payment order does not match the selected plan.' });
    }

    if (
      payment.order_id !== razorpay_order_id ||
      payment.amount !== selectedPlan.amount ||
      payment.currency !== selectedPlan.currency ||
      !['authorized', 'captured'].includes(payment.status)
    ) {
      return res.status(400).json({ error: 'Payment is not valid for this order.' });
    }

    const result = await transaction(async (client) => {
      const planResult = await client.query(
        'SELECT id, name FROM plans WHERE name = $1 AND is_active = true',
        [planName]
      );
      const plan = planResult.rows[0];
      if (!plan) throw new Error('Plan not found.');

      const startDate = new Date();
      const endDate = addDays(startDate, selectedPlan.durationDays);
      const tenantResult = await client.query(
        `UPDATE tenants
         SET plan_id = $1,
             subscription_status = 'active',
             subscription_start = $2,
             subscription_end = $3,
             updated_at = CURRENT_TIMESTAMP,
             settings = COALESCE(settings, '{}'::jsonb) || $4::jsonb
         WHERE id = $5
         RETURNING id, name, slug, business_type, subscription_status, trial_ends_at,
                   subscription_start, subscription_end`,
        [
          plan.id,
          startDate,
          endDate,
          JSON.stringify({
            last_payment: {
              provider: 'razorpay',
              order_id: razorpay_order_id,
              payment_id: razorpay_payment_id,
              plan_name: plan.name,
              billing_period: billingPeriod,
              amount: selectedPlan.amount,
              currency: selectedPlan.currency,
              paid_at: startDate.toISOString(),
            },
          }),
          req.tenantId,
        ]
      );

      return { plan, tenant: tenantResult.rows[0] };
    });

    res.json({
      message: `${result.plan.name} ${billingPeriod} plan activated.`,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
        business_type: result.tenant.business_type,
        subscriptionStatus: result.tenant.subscription_status,
        trialEndsAt: result.tenant.trial_ends_at,
        subscriptionStart: result.tenant.subscription_start,
        subscriptionEnd: result.tenant.subscription_end,
      },
    });
  } catch (error) {
    console.error('Verify Razorpay payment error:', error);
    res.status(500).json({ error: error.message || 'Failed to verify payment.' });
  }
};

module.exports = { getPlans, createOrder, verifyPayment };
