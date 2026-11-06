// CurveLead Voice: pure logic + provider adapter. No network, no DB, no real calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { chargeMinor, affordableSeconds, applyMarkupBps } = require('../services/voiceCalling/money');
const { normalizeDestination } = require('../services/voiceCalling/phone');
const { evaluateCallPolicy } = require('../services/voiceCalling/countryPolicy');
const { createTelnyxProvider } = require('../services/voiceCalling/providers/telnyx');
const { getVoiceProvider, registerVoiceProvider, resetVoiceProviders } = require('../services/voiceCalling/providers/factory');
const { unansweredStatus } = require('../services/voiceCalling/webhooks');

test('charges round UP to the billing increment and to the next minor unit, in integers', () => {
  // 1.50 INR/min = 1_500_000 micro; 61s at 60s increment => 2 min => 3.00 INR = 300 paise
  assert.equal(chargeMinor(61, 1500000, 60), 300n);
  assert.equal(chargeMinor(0, 1500000, 60), 0n);
  assert.equal(chargeMinor(1, 1500000, 60), 150n);
  // per-second billing, sub-paisa rate rounds up: 1s at 0.0100/min = 166.67 micro -> 1 paisa
  assert.equal(chargeMinor(1, 10000, 1), 1n);
  assert.equal(typeof chargeMinor(10, 100, 1), 'bigint');
});
test('affordable seconds never exceed the balance', () => {
  for (const [bal, rate, inc] of [[300, 1500000, 60], [299, 1500000, 60], [1, 1500000, 1], [100000, 7777, 6]]) {
    const s = affordableSeconds(bal, rate, inc);
    assert.ok(chargeMinor(s, rate, inc) <= BigInt(bal), `charge(${s}) must fit ${bal}`);
    assert.ok(chargeMinor(s + BigInt(inc), rate, inc) > BigInt(bal), 'and one more increment must not');
  }
  assert.equal(affordableSeconds(0, 1500000, 60), 0n);
  assert.equal(affordableSeconds(100, 0, 60), null);
});
test('markup is applied in basis points, rounding up', () => {
  assert.equal(applyMarkupBps(1000000, 1500), 1150000n);
  assert.equal(applyMarkupBps(3, 3333), 4n);
});

test('phone numbers normalize to E.164 and invalid ones are rejected', () => {
  assert.equal(normalizeDestination('09665624277', 'IN').e164, '+919665624277');
  assert.equal(normalizeDestination('+971 50 123 4567').country, 'AE');
  assert.equal(normalizeDestination('12345', 'IN'), null);
  assert.equal(normalizeDestination('not a number'), null);
  assert.equal(normalizeDestination('+'.padEnd(60, '9')), null);
  assert.equal(normalizeDestination('+9118001234567').type, 'TOLL_FREE');
});

const okCtx = () => ({
  originCountry: 'IN',
  destination: normalizeDestination('+919665624277'),
  account: { status: 'active', allowed_destination_countries: ['IN'], business_verification_status: 'verified', max_call_seconds: 1800, recording_enabled: false },
  policy: { enabled: true, requires_business_verification: true, requires_verified_caller_id: true, requires_contact_consent: true, recording_allowed: false,
    allowed_number_types: ['MOBILE'], calling_hours_start: '00:00', calling_hours_end: '23:59', destination_timezone: 'Asia/Kolkata', max_call_seconds: 600 },
  callerId: { verification_status: 'verified' }, hasActiveConsent: true, wantRecording: false, now: new Date('2026-06-01T06:00:00Z'),
});
test('policy allows only when every condition passes, and caps duration at the stricter limit', () => {
  const r = evaluateCallPolicy(okCtx());
  assert.deepEqual(r, { allowed: true, maxCallSeconds: 600 });
});
test('policy fails closed on each missing condition', () => {
  const cases = {
    ACCOUNT_INACTIVE: (c) => { c.account.status = 'pending'; },
    ORG_COUNTRY_UNKNOWN: (c) => { c.originCountry = null; },
    INVALID_NUMBER: (c) => { c.destination = null; },
    ROUTE_DISABLED: (c) => { c.policy.enabled = false; },
    DESTINATION_NOT_ALLOWED: (c) => { c.account.allowed_destination_countries = []; },
    NUMBER_TYPE_BLOCKED: (c) => { c.destination = normalizeDestination('+9118001234567'); c.account.allowed_destination_countries = ['IN']; },
    BUSINESS_NOT_VERIFIED: (c) => { c.account.business_verification_status = 'pending'; },
    NO_VERIFIED_CALLER_ID: (c) => { c.callerId = null; },
    NO_CONSENT: (c) => { c.hasActiveConsent = false; },
    RECORDING_NOT_PERMITTED: (c) => { c.wantRecording = true; },
    OUTSIDE_CALLING_HOURS: (c) => { c.policy.calling_hours_start = '09:00'; c.policy.calling_hours_end = '10:00'; },
    POLICY_INVALID: (c) => { c.policy.calling_hours_start = 'bad'; },
  };
  for (const [code, mutate] of Object.entries(cases)) {
    const c = okCtx(); mutate(c);
    assert.equal(evaluateCallPolicy(c).code, code, code);
  }
  assert.equal(evaluateCallPolicy({ ...okCtx(), policy: null }).code, 'ROUTE_DISABLED');
});
test('calling hours use the destination timezone, including overnight windows', () => {
  const c = okCtx(); c.policy.calling_hours_start = '09:00'; c.policy.calling_hours_end = '21:00';
  c.now = new Date('2026-06-01T04:00:00Z'); // 09:30 IST
  assert.equal(evaluateCallPolicy(c).allowed, true);
  c.now = new Date('2026-06-01T16:30:00Z'); // 22:00 IST
  assert.equal(evaluateCallPolicy(c).code, 'OUTSIDE_CALLING_HOURS');
});

// ---- Telnyx adapter -------------------------------------------------------------------------
const keys = crypto.generateKeyPairSync('ed25519');
const rawPub = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const now = Date.UTC(2026, 5, 1, 10, 0, 0);
const sign = (ts, body) => crypto.sign(null, Buffer.from(`${ts}|${body}`), keys.privateKey).toString('base64');
const evBody = (over = {}) => JSON.stringify({ data: { id: 'evt-1', event_type: 'call.hangup', occurred_at: '2026-06-01T10:00:00Z',
  payload: { call_control_id: 'cc-1', call_session_id: 'cs-1', client_state: 'abc', start_time: '2026-06-01T09:58:00Z', end_time: '2026-06-01T10:00:00Z', hangup_cause: 'normal_clearing', ...over } } });
const provider = (extra = {}) => createTelnyxProvider({ publicKey: rawPub, apiKey: 'k', now: () => now, ...extra });
const ts = String(Math.floor(now / 1000));

test('Telnyx webhook: valid Ed25519 signature is accepted and normalized', () => {
  const body = evBody();
  const ev = provider().verifyWebhook({ rawBody: Buffer.from(body), headers: { 'telnyx-signature-ed25519': sign(ts, body), 'telnyx-timestamp': ts } });
  assert.equal(ev.type, 'hangup'); assert.equal(ev.providerEventId, 'evt-1'); assert.equal(ev.providerCallId, 'cc-1');
  assert.equal(ev.detail.hangupCause, 'normal_clearing'); assert.equal(ev.detail.endTime.toISOString(), '2026-06-01T10:00:00.000Z');
});
test('Telnyx webhook: tampered body, wrong key, stale timestamp and missing headers are all rejected', () => {
  const body = evBody(); const good = { 'telnyx-signature-ed25519': sign(ts, body), 'telnyx-timestamp': ts };
  const p = provider();
  assert.throws(() => p.verifyWebhook({ rawBody: Buffer.from(body.replace('cc-1', 'cc-2')), headers: good }), /signature/);
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  assert.throws(() => provider({ publicKey: other }).verifyWebhook({ rawBody: Buffer.from(body), headers: good }), /signature/);
  const old = String(Math.floor(now / 1000) - 301);
  assert.throws(() => p.verifyWebhook({ rawBody: Buffer.from(body), headers: { 'telnyx-signature-ed25519': sign(old, body), 'telnyx-timestamp': old } }), /tolerance/);
  assert.throws(() => p.verifyWebhook({ rawBody: Buffer.from(body), headers: {} }), /Missing/);
  assert.throws(() => createTelnyxProvider({ now: () => now, publicKey: '' }).verifyWebhook({ rawBody: Buffer.from(body), headers: good }), /not configured/);
  assert.throws(() => provider({ publicKey: 'AAAA' }).verifyWebhook({ rawBody: Buffer.from(body), headers: good }), /signature/);
});
test('Telnyx initiateCall sends the verified request shape and never leaks the key in errors', async () => {
  const calls = [];
  const http = { request: async (r) => { calls.push(r); return { data: { data: { call_control_id: 'cc-9', call_session_id: 'cs-9' } } }; } };
  const out = await provider({ http }).initiateCall({ account: { provider_account_reference: 'conn-1' }, from: '+1', to: '+2', clientState: 'cs', commandId: 'cmd', timeLimitSeconds: 5 });
  assert.deepEqual(out, { providerCallId: 'cc-9', providerSessionId: 'cs-9' });
  assert.equal(calls[0].url, '/calls'); assert.equal(calls[0].data.connection_id, 'conn-1'); assert.equal(calls[0].data.time_limit_secs, 30); // clamped to Telnyx minimum
  const bad = { request: async () => { const e = new Error('boom'); e.response = { status: 503 }; throw e; } };
  await assert.rejects(provider({ http: bad, apiKey: 'SECRET-KEY' }).hangupCall({ providerCallId: 'x' }), (e) => e.retryable === true && !/SECRET-KEY/.test(e.message));
});
test('Twilio is a contract only: the factory refuses to hand out an unimplemented provider', () => {
  resetVoiceProviders();
  assert.throws(() => getVoiceProvider('twilio'), /not implemented/);
  assert.throws(() => getVoiceProvider('nope'), /Unknown/);
  registerVoiceProvider({ id: 'fake', capabilities: {}, createClientToken() {}, initiateCall() {}, hangupCall() {}, getCallDetails() {}, verifyWebhook() {} });
  assert.equal(getVoiceProvider('fake').id, 'fake');
  resetVoiceProviders();
});
test('hangup causes map to terminal statuses; unknown causes fail rather than bill', () => {
  assert.equal(unansweredStatus('user_busy'), 'busy'); assert.equal(unansweredStatus('no_answer'), 'no_answer');
  assert.equal(unansweredStatus('originator_cancel'), 'canceled'); assert.equal(unansweredStatus('???'), 'failed');
});

// ---- wallet recharge: gateway failures become a clear 503, with a safe log line --------------------
test('a Razorpay authentication failure becomes "payments unavailable", logged without secrets', async () => {
  const { createTopupService } = require('../services/voiceCalling/topups');
  const rows = [];
  const db = async (sql) => (/FROM voice_accounts/.test(sql) ? { rows: [{ default_currency: 'INR', status: 'active' }] } : { rows, rowCount: 0 });
  const razorpayError = { statusCode: 401, error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }; // the SDK's real shape: a plain object
  const gateway = { orders: { create: async () => { throw razorpayError; } }, payments: { fetch: async () => { throw razorpayError; } } };
  const t = createTopupService({ query: db, wallet: {}, gateway, keySecret: 'SECRET-xyz', keyId: 'rzp_live_abc' });
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    await assert.rejects(t.createOrder({ user: { id: 'u' }, tenantId: 't', amountMinor: 50000 }),
      (e) => e.status === 503 && e.code === 'GATEWAY_UNAVAILABLE' && /temporarily unavailable/.test(e.message));
  } finally { console.error = orig; }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /401 BAD_REQUEST_ERROR: Authentication failed/);
  assert.ok(!logged[0].includes('SECRET-xyz') && !logged[0].includes('rzp_live_abc'));
});
