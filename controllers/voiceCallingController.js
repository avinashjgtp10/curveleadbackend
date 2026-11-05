const { query } = require('../config/db');
const { services } = require('../services/voiceCalling');
const { computeVoiceEnabled, validateVoiceConfig, voiceUnavailable } = require('../services/voiceCalling/config');

const providerId = () => process.env.VOICE_DEFAULT_PROVIDER || 'telnyx';
const originCountry = (req) => req.user.tenant_settings?.country || null;

// Domain errors carry {status, code}; anything else is logged server-side and hidden from the client.
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('Voice API error:', e.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
};

const accountCurrency = async (tenantId) =>
  (await query('SELECT default_currency FROM voice_accounts WHERE tenant_id=$1 AND provider=$2', [tenantId, providerId()])).rows[0]?.default_currency;

// Platform keys missing or malformed => placing calls is refused (503) and status reports enabled:false.
const requireConfigured = () => { if (!validateVoiceConfig().ok) throw voiceUnavailable(); };

const serialize = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));

// Lets the UI decide whether to show calling at all. Informational only: authorize() re-checks everything.
exports.status = handle(async (req, res) => {
  const a = (await query('SELECT status, default_currency, provider_account_reference FROM voice_accounts WHERE tenant_id=$1 AND provider=$2', [req.tenantId, providerId()])).rows[0];
  const canCall = await require('../utils/permissions').hasPermission(req.user, 'voice.call');
  const callerIds = a ? (await query(`SELECT phone_number_e164, verification_status FROM voice_phone_numbers WHERE tenant_id=$1 AND provider=$2 AND verification_status='verified'`, [req.tenantId, providerId()])).rows : [];
  const enabled = computeVoiceEnabled({ config: validateVoiceConfig(), account: a, callerIds, canCall });
  res.json({ enabled, accountStatus: a?.status || 'none', canCall, currency: a?.default_currency || null });
});

exports.token = handle(async (req, res) => {
  requireConfigured();
  res.json(await services().tokens.issue({ user: req.user, tenantId: req.tenantId }));
});

exports.authorize = handle(async (req, res) => {
  requireConfigured();
  const { leadId, recording } = req.body || {};
  if (!leadId || typeof leadId !== 'string') return res.status(400).json({ error: 'leadId is required.' });
  res.json(await services().calls.authorize({ user: req.user, tenantId: req.tenantId, originCountry: originCountry(req), leadId, wantRecording: recording === true }));
});

exports.createCall = handle(async (req, res) => {
  requireConfigured();
  const { authorizationId } = req.body || {};
  if (!authorizationId) return res.status(400).json({ error: 'authorizationId is required.' });
  res.status(202).json(await services().calls.initiate({ user: req.user, tenantId: req.tenantId, authorizationId, mode: req.body.mode === 'server' ? 'server' : 'client' }));
});

exports.hangup = handle(async (req, res) => {
  res.json(await services().calls.hangup({ user: req.user, tenantId: req.tenantId, callId: req.params.id }));
});

exports.listCalls = handle(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50; const offset = parseInt(req.query.offset, 10) || 0;
  res.json(serialize(await services().calls.list({ user: req.user, tenantId: req.tenantId, limit, offset, leadId: req.query.leadId })));
});

exports.getCall = handle(async (req, res) => {
  res.json(serialize(await services().calls.get({ user: req.user, tenantId: req.tenantId, callId: req.params.id })));
});

exports.outcome = handle(async (req, res) => {
  const { outcome, notes } = req.body || {};
  res.json(await services().calls.setOutcome({ user: req.user, tenantId: req.tenantId, callId: req.params.id, outcome, notes }));
});

exports.agentReport = handle(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 86400000);
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: 'Invalid date range.' });
  res.json(serialize(await services().calls.agentReport({ tenantId: req.tenantId, from, to })));
});

exports.rates = handle(async (req, res) => {
  const currency = await accountCurrency(req.tenantId);
  if (!currency) return res.json([]);
  res.json(serialize(await services().rates.listRates({ tenantId: req.tenantId, provider: providerId(), currency })));
});

exports.numbers = handle(async (req, res) => {
  const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
  const r = await query(
    `SELECT id, phone_number_e164, country_code, verification_status, assigned_agent_id FROM voice_phone_numbers
     WHERE tenant_id=$1 AND ($2::boolean OR assigned_agent_id=$3 OR assigned_agent_id IS NULL) ORDER BY created_at`, [req.tenantId, isAdmin, req.user.id]);
  res.json(r.rows);
});

exports.wallet = handle(async (req, res) => {
  const currency = await accountCurrency(req.tenantId);
  res.json(serialize((currency && await services().wallet.getWallet(req.tenantId, currency)) || null));
});

exports.walletTransactions = handle(async (req, res) => {
  res.json(serialize(await services().wallet.listTransactions(req.tenantId, { limit: parseInt(req.query.limit, 10) || 50, offset: parseInt(req.query.offset, 10) || 0 })));
});

exports.registerDevice = handle(async (req, res) => {
  const { deviceId, platform, pushToken } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 120 || !['web', 'ios', 'android'].includes(platform)) return res.status(400).json({ error: 'deviceId and platform (web|ios|android) are required.' });
  await query(
    `INSERT INTO voice_agent_devices (tenant_id, user_id, device_id, platform, push_token) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, user_id, device_id) DO UPDATE SET platform=EXCLUDED.platform, push_token=EXCLUDED.push_token, last_seen_at=NOW()`,
    [req.tenantId, req.user.id, deviceId, platform, pushToken || null]);
  res.status(204).end();
});

// Wallet recharge. Needs admin or the voice.manage permission; credit happens only after gateway confirmation.
const requireManage = async (req) => {
  if (!(await require('../utils/permissions').hasPermission(req.user, 'voice.manage'))) throw Object.assign(new Error('You do not have permission to manage the calling wallet.'), { status: 403, code: 'FORBIDDEN' });
};
exports.topupCreate = handle(async (req, res) => {
  await requireManage(req);
  res.json(await services().topups.createOrder({ user: req.user, tenantId: req.tenantId, amountMinor: req.body?.amountMinor }));
});
exports.topupVerify = handle(async (req, res) => {
  await requireManage(req);
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  res.json(await services().topups.verify({ tenantId: req.tenantId, orderId, paymentId, signature }));
});

// Telnyx webhook: raw bytes captured by express.json's verify hook in server.js.
exports.telnyxWebhook = async (req, res) => {
  try {
    const out = await services().webhooks.handle({ providerId: 'telnyx', rawBody: req.rawBody, headers: req.headers });
    res.status(200).json({ ok: true, ...(out.duplicate ? { duplicate: true } : {}) });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: 'Invalid webhook.' });
    console.error('Voice webhook error:', e.message);
    res.status(500).json({ error: 'Webhook processing failed.' }); // non-2xx => Telnyx retries; idempotency makes that safe
  }
};
