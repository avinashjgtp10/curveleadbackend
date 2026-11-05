const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { validateVoiceConfig, logVoiceConfig } = require('../services/voiceCalling/config');
const { createTelnyxProvider, ED25519_SPKI_PREFIX } = require('../services/voiceCalling/providers/telnyx');

const goodPub = crypto.randomBytes(32).toString('base64');
const good = { VOICE_TELNYX_API_KEY: 'KEY0123abc', VOICE_TELNYX_PUBLIC_KEY: goodPub };

test('valid keys pass', () => assert.deepEqual(validateVoiceConfig(good), { provider: 'telnyx', configured: true, ok: true, errors: [] }));
test('nothing set = disabled, not an error', () => {
  const r = validateVoiceConfig({});
  assert.equal(r.ok, false); assert.equal(r.configured, false); assert.deepEqual(r.errors, []);
});
test('API key must start with KEY', () => assert.match(validateVoiceConfig({ ...good, VOICE_TELNYX_API_KEY: 'sk_live_x' }).errors[0], /must start with "KEY"/));
test('missing either key is reported', () => {
  assert.match(validateVoiceConfig({ VOICE_TELNYX_API_KEY: 'KEY1' }).errors[0], /PUBLIC_KEY is missing/);
  assert.match(validateVoiceConfig({ VOICE_TELNYX_PUBLIC_KEY: goodPub }).errors[0], /API_KEY is missing/);
});
test('public key must be base64 of exactly 32 bytes', () => {
  for (const bad of ['not base64!!', crypto.randomBytes(31).toString('base64'), crypto.randomBytes(33).toString('base64'), goodPub.slice(0, -1)]) {
    assert.equal(validateVoiceConfig({ ...good, VOICE_TELNYX_PUBLIC_KEY: bad }).ok, false, bad);
  }
});
test('unimplemented provider is rejected', () => assert.equal(validateVoiceConfig({ ...good, VOICE_DEFAULT_PROVIDER: 'twilio' }).ok, false));
test('logging never prints secret values and never throws', () => {
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  logVoiceConfig({ VOICE_TELNYX_API_KEY: 'KEYsecretvalue', VOICE_TELNYX_PUBLIC_KEY: 'bad' }, log);
  logVoiceConfig(good, log);
  assert.ok(lines.length >= 3);
  assert.ok(!lines.join('\n').includes('secretvalue') && !lines.join('\n').includes(goodPub));
});

// Webhook verification path: signed ok; unsigned, wrong key, tampered body and stale timestamp are all rejected.
test('webhook verification uses the public key, requires both headers and rejects stale/invalid', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw32 = publicKey.export({ format: 'der', type: 'spki' }).subarray(ED25519_SPKI_PREFIX.length);
  assert.equal(raw32.length, 32);
  const NOW = 1_800_000_000_000;
  const p = createTelnyxProvider({ publicKey: raw32.toString('base64'), now: () => NOW });
  const body = Buffer.from(JSON.stringify({ data: { id: 'e1', event_type: 'call.answered', payload: { call_control_id: 'c1' } } }));
  const sign = (ts, b) => crypto.sign(null, Buffer.concat([Buffer.from(`${ts}|`), b]), privateKey).toString('base64');
  const ts = String(NOW / 1000);
  const headers = (t, s) => ({ 'telnyx-timestamp': t, 'telnyx-signature-ed25519': s });

  assert.equal(p.verifyWebhook({ rawBody: body, headers: headers(ts, sign(ts, body)) }).providerEventId, 'e1');
  assert.throws(() => p.verifyWebhook({ rawBody: body, headers: {} }), /Missing/);
  assert.throws(() => p.verifyWebhook({ rawBody: body, headers: headers(ts, 'AAAA') }), /Invalid/);
  assert.throws(() => p.verifyWebhook({ rawBody: Buffer.from('{"data":{"id":"x"}}'), headers: headers(ts, sign(ts, body)) }), /Invalid/);
  const old = String(NOW / 1000 - 301);
  assert.throws(() => p.verifyWebhook({ rawBody: body, headers: headers(old, sign(old, body)) }), /tolerance/);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const wrong = crypto.sign(null, Buffer.concat([Buffer.from(`${ts}|`), body]), other).toString('base64');
  assert.throws(() => p.verifyWebhook({ rawBody: body, headers: headers(ts, wrong) }), /Invalid/);
  assert.throws(() => createTelnyxProvider({ now: () => NOW, publicKey: '' }).verifyWebhook({ rawBody: body, headers: headers(ts, sign(ts, body)) }), /not configured/);
});
