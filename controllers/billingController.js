const { query } = require('../config/db');
const crypto = require('crypto');

// Note: In production, install razorpay package: npm install razorpay
// const Razorpay = require('razorpay');
// const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });

// POST /api/billing/create-order - Create Razorpay order for plan subscription
const createOrder = async (req, res) => {
  try {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'Plan ID required.' });

    const plan = await query('SELECT * FROM plans WHERE id = $1', [plan_id]);
    if (plan.rows.length === 0) return res.status(404).json({ error: 'Plan not found.' });

    const p = plan.rows[0];
    const amount = Math.round(parseFloat(p.price) * 100); // Razorpay uses paise

    // In production, uncomment:
    // const order = await razorpay.orders.create({
    //   amount,
    //   currency: 'INR',
    //   receipt: `cl_${req.tenantId}_${Date.now()}`,
    //   notes: { tenant_id: req.tenantId, plan_id: p.id, plan_name: p.name },
    // });

    // Dev mode - simulate order
    const order = {
      id: `order_dev_${Date.now()}`,
      amount,
      currency: 'INR',
      status: 'created',
    };

    // Store pending invoice
    await query(
      `INSERT INTO invoices (tenant_id, plan_id, amount, tax, total, status, razorpay_order_id, billing_period_start, billing_period_end)
       VALUES ($1, $2, $3, 0, $3, 'pending', $4, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days')`,
      [req.tenantId, plan_id, parseFloat(p.price), order.id]
    );

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
      plan: { name: p.name, price: parseFloat(p.price) },
    });
  } catch (error) { console.error('Create order error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/billing/verify-payment - Verify Razorpay payment
const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // In production, verify signature:
    // const body = razorpay_order_id + "|" + razorpay_payment_id;
    // const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
    // if (expectedSignature !== razorpay_signature) return res.status(400).json({ error: 'Invalid payment signature.' });

    // Update invoice
    await query(
      `UPDATE invoices SET status = 'paid', razorpay_payment_id = $1, paid_at = NOW()
       WHERE razorpay_order_id = $2 AND tenant_id = $3`,
      [razorpay_payment_id || `pay_dev_${Date.now()}`, razorpay_order_id, req.tenantId]
    );

    // Activate subscription
    const invoice = await query('SELECT plan_id FROM invoices WHERE razorpay_order_id = $1', [razorpay_order_id]);
    if (invoice.rows.length > 0) {
      await query(
        `UPDATE tenants SET plan_id = $1, subscription_status = 'active',
         subscription_start = CURRENT_DATE, subscription_end = CURRENT_DATE + INTERVAL '30 days'
         WHERE id = $2`,
        [invoice.rows[0].plan_id, req.tenantId]
      );
    }

    res.json({ message: 'Payment verified. Subscription activated!' });
  } catch (error) { console.error('Verify payment error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/billing/invoices - Get billing history
const getInvoices = async (req, res) => {
  try {
    const result = await query(
      `SELECT i.*, p.name as plan_name FROM invoices i
       LEFT JOIN plans p ON i.plan_id = p.id
       WHERE i.tenant_id = $1 ORDER BY i.created_at DESC`,
      [req.tenantId]
    );
    res.json({ invoices: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/billing/current - Get current subscription
const getCurrentSubscription = async (req, res) => {
  try {
    const result = await query(
      `SELECT t.subscription_status, t.subscription_start, t.subscription_end, t.trial_ends_at,
              p.name as plan_name, p.price as plan_price, p.features
       FROM tenants t LEFT JOIN plans p ON t.plan_id = p.id WHERE t.id = $1`,
      [req.tenantId]
    );
    res.json({ subscription: result.rows[0] || null });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/billing/webhook - Razorpay webhook
const handleWebhook = async (req, res) => {
  try {
    res.sendStatus(200);

    const { event, payload } = req.body;

    if (event === 'payment.captured') {
      const paymentId = payload.payment?.entity?.id;
      const orderId = payload.payment?.entity?.order_id;

      if (orderId) {
        await query(
          `UPDATE invoices SET status = 'paid', razorpay_payment_id = $1, paid_at = NOW()
           WHERE razorpay_order_id = $2`,
          [paymentId, orderId]
        );
        console.log(`✅ Razorpay payment captured: ${paymentId}`);
      }
    }

    if (event === 'payment.failed') {
      const orderId = payload.payment?.entity?.order_id;
      if (orderId) {
        await query("UPDATE invoices SET status = 'failed' WHERE razorpay_order_id = $1", [orderId]);
        console.log(`❌ Razorpay payment failed: ${orderId}`);
      }
    }
  } catch (error) { console.error('Razorpay webhook error:', error); }
};

module.exports = { createOrder, verifyPayment, getInvoices, getCurrentSubscription, handleWebhook };
