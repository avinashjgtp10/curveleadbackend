// Platform hard limits: destination allow-list, per-destination time zones and the UAE hours ceiling, /status gating.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDestination } = require('../services/voiceCalling/phone');
const { evaluateCallPolicy, platformAllows } = require('../services/voiceCalling/countryPolicy');
const { computeVoiceEnabled } = require('../services/voiceCalling/config');

const policy = (over = {}) => ({ enabled: true, requires_business_verification: false, requires_verified_caller_id: true, requires_contact_consent: false,
  recording_allowed: false, allowed_number_types: ['MOBILE', 'FIXED_LINE', 'FIXED_LINE_OR_MOBILE'], calling_hours_start: '00:00', calling_hours_end: '23:59',
  destination_timezone: 'UTC', max_call_seconds: 600, ...over });
const ctx = (number, over = {}, pol = {}) => ({
  originCountry: 'IN', destination: normalizeDestination(number),
  account: { status: 'active', allowed_destination_countries: ['IN', 'SG', 'AE', 'US', 'GB'], business_verification_status: 'verified', max_call_seconds: 1800, recording_enabled: false },
  policy: policy(pol), callerId: { verification_status: 'verified' }, hasActiveConsent: true, wantRecording: false, now: new Date('2026-06-01T06:00:00Z'), ...over });

const IN = '+919665624277', SG = '+6591234567', AE = '+971501234567', US = '+14155552671', GB = '+447911123456';

test('only +91, +65 and +971 can be dialled, even if the database policy and the org list allow more', () => {
  for (const n of [IN, SG, AE]) assert.equal(evaluateCallPolicy(ctx(n)).allowed, true, n);
  for (const n of [US, GB]) {
    const r = evaluateCallPolicy(ctx(n));
    assert.equal(r.allowed, false); assert.equal(r.code, 'ROUTE_DISABLED', n); // existing denial code, no new one
  }
});
test('the allow-list also checks the calling code, and can be narrowed by environment', () => {
  const forged = { country: 'IN', e164: '+14155552671', type: 'MOBILE', digits: '14155552671' };
  assert.equal(platformAllows(forged), false);
  assert.equal(platformAllows(normalizeDestination(AE), { VOICE_ALLOWED_DESTINATIONS: 'IN,SG' }), false);
  assert.equal(platformAllows(normalizeDestination(IN), { VOICE_ALLOWED_DESTINATIONS: 'IN,SG' }), true);
  assert.equal(platformAllows(normalizeDestination(US), { VOICE_ALLOWED_DESTINATIONS: 'IN,SG,AE,US' }), false); // unknown codes are ignored, never widen
  assert.equal(platformAllows(null), false);
});
test('calling hours use the LEAD\'s zone for each destination, whatever the policy row says', () => {
  const at = (iso) => ({ now: new Date(iso) });
  const win = { calling_hours_start: '09:00', calling_hours_end: '21:00' }; // policy zone deliberately wrong (UTC)
  assert.equal(evaluateCallPolicy(ctx(IN, at('2026-06-01T04:00:00Z'), win)).allowed, true);   // 09:30 IST
  assert.equal(evaluateCallPolicy(ctx(IN, at('2026-06-01T03:00:00Z'), win)).code, 'OUTSIDE_CALLING_HOURS'); // 08:30 IST
  assert.equal(evaluateCallPolicy(ctx(SG, at('2026-06-01T01:00:00Z'), win)).allowed, true);   // 09:00 SGT
  assert.equal(evaluateCallPolicy(ctx(SG, at('2026-06-01T00:30:00Z'), win)).code, 'OUTSIDE_CALLING_HOURS'); // 08:30 SGT
  assert.equal(evaluateCallPolicy(ctx(SG, at('2026-06-01T12:59:00Z'), win)).allowed, true);   // 20:59 SGT
  assert.equal(evaluateCallPolicy(ctx(SG, at('2026-06-01T13:00:00Z'), win)).code, 'OUTSIDE_CALLING_HOURS'); // 21:00 SGT: the end is exclusive
});
test('UAE is capped at 09:00-18:00 Dubai time even if the policy row allows more', () => {
  const wide = { calling_hours_start: '00:00', calling_hours_end: '23:59' };
  const at = (iso) => ({ now: new Date(iso) });
  assert.equal(evaluateCallPolicy(ctx(AE, at('2026-06-01T05:00:00Z'), wide)).allowed, true);   // 09:00 GST
  assert.equal(evaluateCallPolicy(ctx(AE, at('2026-06-01T13:59:00Z'), wide)).allowed, true);   // 17:59 GST
  assert.equal(evaluateCallPolicy(ctx(AE, at('2026-06-01T14:00:00Z'), wide)).code, 'OUTSIDE_CALLING_HOURS'); // 18:00 GST
  assert.equal(evaluateCallPolicy(ctx(AE, at('2026-06-01T04:59:00Z'), wide)).code, 'OUTSIDE_CALLING_HOURS'); // 08:59 GST
  assert.equal(evaluateCallPolicy(ctx(AE, at('2026-06-01T20:00:00Z'), wide)).code, 'OUTSIDE_CALLING_HOURS'); // 00:00 GST next day
  // a stricter policy still narrows further
  assert.equal(evaluateCallPolicy(ctx(AE, at('2026-06-01T12:00:00Z'), { calling_hours_start: '10:00', calling_hours_end: '16:00' })).code, 'OUTSIDE_CALLING_HOURS'); // 16:00 GST
  // an overnight policy window cannot sneak past the daytime ceiling
  assert.equal(evaluateCallPolicy(ctx(AE, at('2026-06-01T20:00:00Z'), { calling_hours_start: '20:00', calling_hours_end: '06:00' })).code, 'OUTSIDE_CALLING_HOURS');
});

test('status gating: needs valid keys, active account WITH connection id, a verified E.164 caller ID and permission', () => {
  const ok = { config: { ok: true }, canCall: true, account: { status: 'active', provider_account_reference: '3086510505527870746' },
    callerIds: [{ phone_number_e164: '+15673603199', verification_status: 'verified' }] };
  assert.equal(computeVoiceEnabled(ok), true);
  assert.equal(computeVoiceEnabled({ ...ok, config: { ok: false } }), false);
  assert.equal(computeVoiceEnabled({ ...ok, canCall: false }), false);
  assert.equal(computeVoiceEnabled({ ...ok, account: null }), false);
  assert.equal(computeVoiceEnabled({ ...ok, account: { ...ok.account, status: 'pending' } }), false);
  assert.equal(computeVoiceEnabled({ ...ok, account: { ...ok.account, provider_account_reference: '  ' } }), false);
  assert.equal(computeVoiceEnabled({ ...ok, account: { ...ok.account, provider_account_reference: null } }), false);
  assert.equal(computeVoiceEnabled({ ...ok, callerIds: [] }), false);
  assert.equal(computeVoiceEnabled({ ...ok, callerIds: [{ phone_number_e164: '+15673603199', verification_status: 'pending' }] }), false);
  assert.equal(computeVoiceEnabled({ ...ok, callerIds: [{ phone_number_e164: '15673603199', verification_status: 'verified' }] }), false); // not E.164
});
