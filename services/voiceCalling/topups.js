// Wallet recharge via Razorpay Orders. Credit happens only when Razorpay itself says the payment is captured
// (re-fetched server-side), for the exact amount/currency of an order WE created for that tenant. Both the
// browser verify call and the webhook funnel into settleOrder(); the wallet ledger key makes it once-only.
const crypto = require('crypto');
const { query: defaultQuery } = require('../../config/db');
const { timingSafeEqualStrings } = require('../../utils/cryptoSecrets');
const { audit } = require('./audit');

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const MIN = () => BigInt(process.env.VOICE_TOPUP_MIN_MINOR || 10000);     // default 100.00
const MAX = () => BigInt(process.env.VOICE_TOPUP_MAX_MINOR || 10000000);  // default 100,000.00

function createTopupService(deps = {}) {
  const db = deps.query || defaultQuery;
  const wallet = deps.wallet || require('./wallet').createWalletService({ query: db });
  const gateway = () => deps.gateway || (() => {
    const Razorpay = require('razorpay');
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw fail(503, 'GATEWAY_UNAVAILABLE', 'Payments are not configured.');
    return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  })();
  const keyId = () => deps.keyId || process.env.RAZORPAY_KEY_ID;
  const keySecret = () => deps.keySecret || process.env.RAZORPAY_KEY_SECRET;

  // Credits the wallet iff Razorpay reports the payment captured and it matches our order. Returns 'credited'|'already'|'pending'.
  async function settleOrder({ orderId, paymentId }) {
    const order = (await db('SELECT * FROM voice_topup_orders WHERE razorpay_order_id=$1', [orderId])).rows[0];
    if (!order) throw fail(404, 'ORDER_NOT_FOUND', 'Unknown order.');
    if (order.status === 'paid') return 'already';
    const p = await gateway().payments.fetch(paymentId);
    if (p.order_id !== orderId) throw fail(400, 'ORDER_MISMATCH', 'Payment does not belong to this order.');
    if (p.status !== 'captured') return 'pending'; // authorized/failed: do not credit
    if (String(p.amount) !== String(order.amount_minor) || p.currency !== order.currency) {
      await audit(db, { tenantId: order.tenant_id, action: 'topup.amount_mismatch', entityId: orderId, detail: { paymentId } });
      throw fail(400, 'AMOUNT_MISMATCH', 'Payment amount does not match the order.');
    }
    const r = await wallet.topUp({ tenantId: order.tenant_id, currency: order.currency, amountMinor: order.amount_minor, confirmedPaymentId: paymentId });
    await db(`UPDATE voice_topup_orders SET status='paid', razorpay_payment_id=$2, paid_at=NOW() WHERE razorpay_order_id=$1 AND status<>'paid'`, [orderId, paymentId]);
    await audit(db, { tenantId: order.tenant_id, action: 'topup.credited', entityId: orderId, detail: { paymentId, applied: r.applied } });
    return r.applied ? 'credited' : 'already';
  }

  return {
    settleOrder,

    async createOrder({ user, tenantId, amountMinor }) {
      let amount;
      try { amount = BigInt(amountMinor); } catch { throw fail(400, 'BAD_AMOUNT', 'Enter a valid amount.'); }
      if (amount < MIN() || amount > MAX()) throw fail(400, 'BAD_AMOUNT', `Amount must be between ${MIN() / 100n} and ${MAX() / 100n}.`);
      const acct = (await db(`SELECT default_currency, status FROM voice_accounts WHERE tenant_id=$1 AND provider=$2`, [tenantId, process.env.VOICE_DEFAULT_PROVIDER || 'telnyx'])).rows[0];
      if (!acct || acct.status !== 'active') throw fail(403, 'ACCOUNT_INACTIVE', 'Calling is not enabled for this organization.');
      const receipt = `vw_${crypto.randomBytes(8).toString('hex')}`;
      const order = await gateway().orders.create({ amount: Number(amount), currency: acct.default_currency, receipt, notes: { kind: 'voice_wallet', tenant_id: tenantId } });
      await db(`INSERT INTO voice_topup_orders (tenant_id, user_id, razorpay_order_id, amount_minor, currency) VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, user.id, order.id, String(amount), acct.default_currency]);
      return { orderId: order.id, amount: Number(amount), currency: acct.default_currency, keyId: keyId() };
    },

    // Browser handoff after checkout: verify Razorpay's HMAC, then confirm with the gateway before crediting.
    async verify({ tenantId, orderId, paymentId, signature }) {
      if (!orderId || !paymentId || !signature) throw fail(400, 'BAD_REQUEST', 'Missing payment details.');
      const expected = crypto.createHmac('sha256', keySecret() || '').update(`${orderId}|${paymentId}`).digest('hex');
      if (!keySecret() || !timingSafeEqualStrings(expected, signature)) throw fail(400, 'BAD_SIGNATURE', 'Payment signature verification failed.');
      const own = (await db('SELECT 1 FROM voice_topup_orders WHERE razorpay_order_id=$1 AND tenant_id=$2', [orderId, tenantId])).rowCount;
      if (!own) throw fail(404, 'ORDER_NOT_FOUND', 'Unknown order.');
      return { result: await settleOrder({ orderId, paymentId }) };
    },

    // Called by the shared Razorpay webhook (already signature-checked there) for payment.captured / order.paid.
    async handleWebhookEvent(body) {
      const pay = body.payload?.payment?.entity;
      if (!pay?.order_id || !pay?.id) return false;
      const known = (await db('SELECT 1 FROM voice_topup_orders WHERE razorpay_order_id=$1', [pay.order_id])).rowCount;
      if (!known) return false; // not a wallet order (e.g. subscription payment)
      await settleOrder({ orderId: pay.order_id, paymentId: pay.id });
      return true;
    },
  };
}
module.exports = { createTopupService };
