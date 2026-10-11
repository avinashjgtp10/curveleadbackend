const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const registry = require('../services/voice');
const { createVoiceEventHandler } = require('../services/voiceCalls');

const CONTRACT = ['id', 'label', 'credentials', 'listVoices', 'createCall', 'parseWebhookEvent', 'verifyWebhook'];

test('every registered provider implements the whole contract', () => {
  assert.ok(registry.listProviders().length >= 1);
  for (const { id } of registry.listProviders()) {
    const p = registry.getProvider(id);
    for (const key of CONTRACT) assert.ok(p[key] !== undefined, `${id} is missing ${key}`);
    assert.ok(Array.isArray(p.credentials) && p.credentials.length);
  }
});

test('settings pick the provider; unknown or missing falls back safely', () => {
  assert.equal(registry.providerFor({}).id, 'vapi');
  assert.equal(registry.providerFor({ voice_ai_provider: 'vapi' }).id, 'vapi');
  assert.equal(registry.providerFor({ voice_ai_provider: 'ghost' }), null);
});

test('Vapi signatures: valid passes, wrong fails, absent is "nothing to check"', () => {
  const vapi = registry.getProvider('vapi');
  const body = '{"a":1}', secret = 's3cret';
  const good = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(vapi.verifyWebhook({ secret, rawBody: body, headers: { 'x-vapi-signature': good } }), true);
  assert.equal(vapi.verifyWebhook({ secret, rawBody: body, headers: { 'x-vapi-signature': 'bad' } }), false);
  assert.equal(vapi.verifyWebhook({ secret, rawBody: body, headers: {} }), null);
});

// ── the shared result handler, driven by a fake provider ─────────────────────
const fakeProvider = {
  id: 'fakevoice', label: 'Fake', credentials: [{ key: 'api_key' }], listVoices: () => [], createCall: async () => ({ id: 'x' }),
  verifyWebhook: ({ headers }) => (headers.sig === undefined ? null : headers.sig === 'ok'),
  parseWebhookEvent: (p) => ({ providerCallId: p.id, status: p.status, endedReason: null, durationSeconds: 42, transcript: p.transcript || null, recordingUrl: p.rec || null, costUsd: 0.5, providerSummary: p.psum || null }),
};

function harness({ call = { id: 'c1', tenant_id: 't1', lead_id: 'l1', initiated_by: 'u1', settings: {} }, analyze, archive } = {}) {
  const log = { sql: [], warnings: [] };
  const query = async (sql, args) => {
    log.sql.push([sql, args]);
    if (sql.includes('FROM ai_voice_calls c JOIN tenants')) return { rows: call ? [call] : [] };
    if (sql.includes('SELECT name FROM leads')) return { rows: [{ name: 'Asha' }] };
    return { rows: [] };
  };
  const handle = createVoiceEventHandler({
    query, getProvider: (id) => (id === 'fakevoice' ? fakeProvider : null),
    analyzeRecording: analyze || (async () => ({ summary: 'Asked about pricing.', customer_sentiment: 'positive', next_action: 'Send quote' })),
    archiveRecording: archive || (async () => ({ url: 'https://bucket/call-recordings/t1/c1.mp3' })),
    warn: (m) => log.warnings.push(m), requireSignature: false,
  });
  return { handle, log };
}
const ran = (log, re) => log.sql.filter(([s]) => re.test(s));
const done = (extra = {}) => ({ providerId: 'fakevoice', headers: {}, payload: { id: 'p1', status: 'completed', transcript: 'hello', rec: 'https://cdn.example.com/r.mp3', ...extra } });

test('a completed call stores the status, archives the recording and saves the summary', async () => {
  const { handle, log } = harness();
  const r = await handle(done());
  assert.deepEqual(r, { handled: true, status: 'completed', archived: true, summarized: true });
  assert.equal(ran(log, /SET recording_s3_url/)[0][1][0], 'https://bucket/call-recordings/t1/c1.mp3');
  assert.match(ran(log, /SET analysis/)[0][1][0], /Asked about pricing/);
  assert.match(ran(log, /INSERT INTO lead_activities/)[0][1][2], /Sentiment: positive\. Asked about pricing/);
  assert.equal(ran(log, /SET last_contacted_at/).length, 1);
});

test('if the recording copy fails the call still gets its summary, and the provider link is kept', async () => {
  const { handle, log } = harness({ archive: async () => { throw new Error('link blocked'); } });
  const r = await handle(done());
  assert.equal(r.archived, false);
  assert.equal(r.summarized, true);
  assert.equal(ran(log, /SET recording_s3_url/).length, 0);
  assert.ok(log.warnings.some(w => /not archived.*link blocked/.test(w)));
});

test('if our analysis fails the provider\'s own summary is used', async () => {
  const { handle, log } = harness({ analyze: async () => { throw new Error('model down'); } });
  const r = await handle(done({ psum: 'Lead wants a callback tomorrow.' }));
  assert.equal(r.summarized, true);
  assert.match(ran(log, /SET analysis/)[0][1][0], /callback tomorrow/);
});

test('a call that is not finished only updates its status', async () => {
  const { handle, log } = harness();
  const r = await handle(done({ status: 'ringing', transcript: null, rec: null }));
  assert.deepEqual(r, { handled: true, status: 'ringing' });
  assert.equal(ran(log, /SET analysis|recording_s3_url/).length, 0);
});

test('unknown providers, unknown calls and bad signatures are ignored without writing', async () => {
  let h = harness();
  assert.equal((await h.handle({ providerId: 'ghost', payload: {} })).reason, 'unknown_provider');
  h = harness({ call: null });
  assert.equal((await h.handle(done())).reason, 'unknown_call');
  h = harness();
  assert.equal((await h.handle({ ...done(), headers: { sig: 'forged' } })).reason, 'bad_signature');
  assert.equal(ran(h.log, /UPDATE ai_voice_calls/).length, 0);
});

test('with signatures required, an unsigned message is rejected', async () => {
  const log = { sql: [] };
  const handle = createVoiceEventHandler({
    query: async (sql) => (sql.includes('FROM ai_voice_calls c') ? { rows: [{ id: 'c', tenant_id: 't', lead_id: 'l', settings: {} }] } : { rows: [] }),
    getProvider: () => fakeProvider, requireSignature: true, warn: () => {},
  });
  assert.equal((await handle(done())).reason, 'bad_signature');
});
