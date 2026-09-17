const crypto = require('crypto');
const Razorpay = require('razorpay');
const { query, transaction } = require('../config/db');

// Amounts/description live here (not on Razorpay) because they're what we
// show in the UI and use to validate webhook/verify payloads. The Razorpay
// Plan ID for each entry is created on first use via the Razorpay API and
// cached on the `plans` row (razorpay_plan_id_monthly/yearly) — never hardcoded.
const PLAN_CATALOG = {
  Starter: {
    monthly: { amount: 99900, currency: 'INR', description: 'Starter monthly subscription' },
    yearly: { amount: 999000, currency: 'INR', description: 'Starter yearly subscription' },
  },
  Growth: {
    monthly: { amount: 249900, currency: 'INR', description: 'Growth monthly subscription' },
    yearly: { amount: 2499000, currency: 'INR', description: 'Growth yearly subscription' },
  },
};

// Total billing cycles Razorpay charges before a subscription naturally
// ends. Set high so it behaves like an "until cancelled" subscription.
const TOTAL_CYCLES = { monthly: 60, yearly: 10 };

const RAZORPAY_PLAN_COLUMN = { monthly: 'razorpay_plan_id_monthly', yearly: 'razorpay_plan_id_yearly' };

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

// Fetch the cached Razorpay plan id for this DB plan + period, creating it
// via the Razorpay API (and caching it) the first time it's needed.
const ensureRazorpayPlanId = async (razorpay, plan, billingPeriod, catalogPrice) => {
  const column = RAZORPAY_PLAN_COLUMN[billingPeriod];
  if (plan[column]) return plan[column];

  const rzpPlan = await razorpay.plans.create({
    period: billingPeriod === 'yearly' ? 'yearly' : 'monthly',
    interval: 1,
    item: {
      name: `${plan.name} (${billingPeriod})`,
      amount: catalogPrice.amount,
      currency: catalogPrice.currency,
      description: catalogPrice.description,
    },
    notes: { plan_name: plan.name, billing_period: billingPeriod },
  });

  await query(`UPDATE plans SET ${column} = $1 WHERE id = $2`, [rzpPlan.id, plan.id]);
  return rzpPlan.id;
};

// Find or create the Razorpay customer for this tenant/user so repeat
// subscriptions/upgrades reuse the same customer record.
const ensureRazorpayCustomer = async (razorpay, req) => {
  const tenantResult = await query('SELECT razorpay_customer_id FROM tenants WHERE id = $1', [req.tenantId]);
  const existingId = tenantResult.rows[0]?.razorpay_customer_id;
  if (existingId) return existingId;

  let customer;
  try {
    customer = await razorpay.customers.create({
      name: req.user.name,
      email: req.user.email,
      fail_existing: 0, // return the existing customer if this email is already registered
    });
  } catch (error) {
    if (error.statusCode === 400 && error.error?.metadata?.customer_id) {
      customer = { id: error.error.metadata.customer_id };
    } else {
      throw error;
    }
  }

  await query('UPDATE tenants SET razorpay_customer_id = $1 WHERE id = $2', [customer.id, req.tenantId]);
  return customer.id;
};

const getPlans = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, price, max_leads, max_users
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

const createSubscription = async (req, res) => {
  try {
    const { planName, billingPeriod = 'monthly' } = req.body;
    const selectedPlan = getCatalogPrice(planName, billingPeriod);

    if (!selectedPlan || !['monthly', 'yearly'].includes(billingPeriod)) {
      return res.status(400).json({ error: 'Online checkout is available for Starter and Growth monthly or yearly plans only.' });
    }

    const planResult = await query(
      'SELECT id, name, razorpay_plan_id_monthly, razorpay_plan_id_yearly FROM plans WHERE name = $1 AND is_active = true',
      [planName]
    );
    const plan = planResult.rows[0];
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found.' });
    }

    const razorpay = getRazorpayClient();
    const [razorpayPlanId, customerId] = await Promise.all([
      ensureRazorpayPlanId(razorpay, plan, billingPeriod, selectedPlan),
      ensureRazorpayCustomer(razorpay, req),
    ]);

    const subscription = await razorpay.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_id: customerId,
      customer_notify: 1,
      total_count: TOTAL_CYCLES[billingPeriod],
      notes: {
        tenant_id: req.tenantId,
        plan_id: plan.id,
        plan_name: plan.name,
        billing_period: billingPeriod,
      },
    });

    res.json({
      subscriptionId: subscription.id,
      plan: {
        id: plan.id,
        name: plan.name,
        description: selectedPlan.description,
        billingPeriod,
      },
      amount: selectedPlan.amount,
      currency: selectedPlan.currency,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      prefill: {
        name: req.user.name,
        email: req.user.email,
      },
    });
  } catch (error) {
    console.error('Create Razorpay subscription error:', error);
    res.status(500).json({ error: error.error?.description || error.message || 'Failed to create subscription.' });
  }
};

// Shared by verifySubscription (immediate, client-driven) and the webhook
// (authoritative, server-driven) so both activation paths stay in sync.
const activateTenantSubscription = async ({ tenantId, planName, billingPeriod, subscriptionId, currentEndUnixSeconds, paymentId }) => {
  return transaction(async (client) => {
    const planResult = await client.query('SELECT id, name FROM plans WHERE name = $1 AND is_active = true', [planName]);
    const plan = planResult.rows[0];
    if (!plan) throw new Error('Plan not found.');

    const startDate = new Date();
    const endDate = currentEndUnixSeconds ? new Date(currentEndUnixSeconds * 1000) : null;

    const tenantResult = await client.query(
      `UPDATE tenants
       SET plan_id = $1,
           subscription_status = 'active',
           subscription_start = $2,
           subscription_end = $3,
           razorpay_subscription_id = $4,
           billing_period = $5,
           updated_at = CURRENT_TIMESTAMP,
           settings = COALESCE(settings, '{}'::jsonb) || $6::jsonb
       WHERE id = $7
       RETURNING id, name, slug, business_type, subscription_status, trial_ends_at,
                 subscription_start, subscription_end`,
      [
        plan.id,
        startDate,
        endDate,
        subscriptionId,
        billingPeriod,
        JSON.stringify({
          last_payment: {
            provider: 'razorpay',
            subscription_id: subscriptionId,
            payment_id: paymentId || null,
            plan_name: plan.name,
            billing_period: billingPeriod,
            paid_at: startDate.toISOString(),
          },
        }),
        tenantId,
      ]
    );

    return { plan, tenant: tenantResult.rows[0] };
  });
};

const deactivateTenantSubscription = async ({ subscriptionId, status }) => {
  await query(
    `UPDATE tenants
     SET subscription_status = $1, updated_at = CURRENT_TIMESTAMP
     WHERE razorpay_subscription_id = $2`,
    [status, subscriptionId]
  );
};

const verifySubscription = async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
      planName,
      billingPeriod = 'monthly',
    } = req.body;
    const selectedPlan = getCatalogPrice(planName, billingPeriod);

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature || !selectedPlan) {
      return res.status(400).json({ error: 'Invalid payment verification payload.' });
    }

    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Razorpay secret is not configured.' });
    }

    // Per Razorpay's recurring-payments spec, the checkout signature is
    // HMAC_SHA256(payment_id + "|" + subscription_id, key_secret).
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment signature verification failed.' });
    }

    const razorpay = getRazorpayClient();
    const subscription = await razorpay.subscriptions.fetch(razorpay_subscription_id);

    if (
      subscription.notes?.tenant_id !== req.tenantId ||
      subscription.notes?.plan_name !== planName ||
      subscription.notes?.billing_period !== billingPeriod
    ) {
      return res.status(400).json({ error: 'Subscription does not match the selected plan.' });
    }

    if (!['authenticated', 'active'].includes(subscription.status)) {
      return res.status(400).json({ error: `Subscription is not active yet (status: ${subscription.status}).` });
    }

    const result = await activateTenantSubscription({
      tenantId: req.tenantId,
      planName,
      billingPeriod,
      subscriptionId: razorpay_subscription_id,
      currentEndUnixSeconds: subscription.current_end,
      paymentId: razorpay_payment_id,
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
    console.error('Verify Razorpay subscription error:', error);
    res.status(500).json({ error: error.error?.description || error.message || 'Failed to verify subscription.' });
  }
};

// POST /api/payments/webhook - public endpoint, called by Razorpay only.
// Authoritative source of truth for the subscription lifecycle: it's what
// keeps the workspace's status correct even if the browser tab was closed
// right after payment, and it's the only path that hears about renewals,
// cancellations and payment failures.
const handleWebhook = async (req, res) => {
  res.sendStatus(200); // Always ack fast; Razorpay retries on non-2xx/timeout.

  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not configured.');
      return;
    }

    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody;
    if (!signature || !rawBody) {
      console.warn('Razorpay webhook missing signature or raw body.');
      return;
    }

    const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (expectedSignature !== signature) {
      console.warn('Razorpay webhook signature mismatch.');
      return;
    }

    const event = req.body.event;
    const subscriptionEntity = req.body.payload?.subscription?.entity;
    const paymentEntity = req.body.payload?.payment?.entity;

    if (!event || !subscriptionEntity) {
      return; // Not a subscription event we care about.
    }

    const eventKey = `${event}:${subscriptionEntity.id}:${subscriptionEntity.status}:${paymentEntity?.id || ''}`;
    const inserted = await query(
      `INSERT INTO payment_webhook_events (event_key, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [eventKey, event, JSON.stringify(req.body)]
    );
    if (inserted.rows.length === 0) {
      return; // Already processed this exact event (Razorpay retry).
    }

    const notes = subscriptionEntity.notes || {};

    switch (event) {
      case 'subscription.authenticated':
      case 'subscription.charged':
        if (notes.tenant_id && notes.plan_name && notes.billing_period) {
          await activateTenantSubscription({
            tenantId: notes.tenant_id,
            planName: notes.plan_name,
            billingPeriod: notes.billing_period,
            subscriptionId: subscriptionEntity.id,
            currentEndUnixSeconds: subscriptionEntity.current_end,
            paymentId: paymentEntity?.id || null,
          });
        }
        break;

      case 'subscription.cancelled':
        await deactivateTenantSubscription({ subscriptionId: subscriptionEntity.id, status: 'cancelled' });
        break;

      case 'subscription.halted':
        await deactivateTenantSubscription({ subscriptionId: subscriptionEntity.id, status: 'halted' });
        break;

      default:
        // Not a lifecycle event we act on (e.g. subscription.pending, subscription.updated).
        break;
    }
  } catch (error) {
    console.error('Razorpay webhook processing error:', error);
  }
};

module.exports = { getPlans, createSubscription, verifySubscription, handleWebhook };
