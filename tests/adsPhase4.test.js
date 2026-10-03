const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Phase 4: Conversions API — normalisation + hashing, payload shape, queue transitions.

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, process: { env: {} }, setTimeout, require: k => deps[k] || ({ crypto })[k] || {} });
  return module.exports;
}
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

const capi = (settings = {}, { postFails = false } = {}) => {
  const posted = [], logged = [];
  const mod = load('utils/metaCapi.js', {
    crypto,
    '../config/db': { query: async (sql, p) => (sql.startsWith('SELECT') ? { rows: [{ settings }] } : (logged.push([sql, p]), { rows: [] })) },
    '../config/meta': { GRAPH_URL: 'https://graph' },
    axios: { post: async (...args) => { posted.push(args); if (postFails) throw Object.assign(new Error('bad'), { response: { data: { error: { message: 'Invalid dataset' } } } }); return { data: { events_received: 1 } }; } },
  });
  return { mod, posted, logged };
};

test('customer fields are normalised the way Meta requires before hashing', () => {
  const { normalize } = capi().mod;
  assert.equal(normalize.email('  Priya.Sharma@Gmail.COM '), 'priya.sharma@gmail.com');
  assert.equal(normalize.phone('+91 98765-43210'), '919876543210');
  assert.equal(normalize.phone('9876543210'), '919876543210');        // 10-digit Indian number gets 91
  assert.equal(normalize.phone('+1 (213) 373-4253', 'us'), '12133734253');
  assert.equal(normalize.name("D'Souza"), 'dsouza');
  assert.equal(normalize.city('Navi Mumbai'), 'navimumbai');
  assert.equal(normalize.country('IN'), 'in');
});

test('user data carries the leadgen id and SHA-256 of each normalised field', () => {
  const { buildUserData } = capi().mod;
  const u = buildUserData({ id: 'crm-1', meta_lead_id: '55501', name: 'Priya  Sharma', email: 'P@X.com', phone: '+919876543210', city: 'Pune' });
  assert.equal(u.lead_id, '55501');
  assert.deepEqual(Array.from(u.em), [sha('p@x.com')]);
  assert.deepEqual(Array.from(u.ph), [sha('919876543210')]);
  assert.deepEqual(Array.from(u.fn), [sha('priya')]);
  assert.deepEqual(Array.from(u.ln), [sha('sharma')]);
  assert.deepEqual(Array.from(u.ct), [sha('pune')]);
  assert.deepEqual(Array.from(u.country), [sha('in')]);
  assert.deepEqual(Array.from(u.external_id), [sha('crm-1')]);
  // Missing fields are omitted, and the placeholder name "Unknown" is never sent.
  const bare = buildUserData({ id: 'x', meta_lead_id: '1', name: 'Unknown', phone: '9876543210' });
  assert.equal(bare.fn, undefined);
  assert.equal(bare.em, undefined);
});

test('the event follows the CRM spec with a deterministic event id', async () => {
  const { mod, posted, logged } = capi({ meta_capi_enabled: true, meta_dataset_id: 'DS', meta_capi_access_token: 'tok' });
  const lead = { id: 'crm-1', meta_lead_id: '55501', phone: '+919876543210' };
  assert.equal(await mod.sendLeadConversionEvent({ tenantId: 't', lead, eventName: 'QualifiedLead', eventTime: '2026-10-01T10:00:00Z' }), 'success');
  const [url, body, opts] = posted[0];
  assert.equal(url, 'https://graph/DS/events');
  const ev = body.data[0];
  assert.equal(ev.event_name, 'QualifiedLead');
  assert.equal(ev.event_id, 'crm-1:QualifiedLead');
  assert.equal(ev.action_source, 'system_generated');
  assert.equal(ev.event_time, Math.floor(Date.parse('2026-10-01T10:00:00Z') / 1000));
  assert.deepEqual({ ...ev.custom_data }, { lead_event_source: 'CurveLead', event_source: 'crm' });
  assert.equal(opts.headers.Authorization, 'Bearer tok');
  assert.match(logged[0][0], /ON CONFLICT \(tenant_id, lead_id, event_name\) WHERE status = 'success' DO NOTHING/);
  assert.equal(logged[0][1][5], 'crm-1:QualifiedLead');
});

test('switched on without a dataset is reported as not configured, without calling Meta', async () => {
  const { mod, posted } = capi({ meta_capi_enabled: true });
  assert.equal(await mod.sendLeadConversionEvent({ tenantId: 't', lead: { id: 'l', meta_lead_id: 'm' }, eventName: 'QualifiedLead' }), 'not_configured');
  assert.equal(posted.length, 0);
  const off = capi({ meta_capi_enabled: false, meta_dataset_id: 'DS', meta_capi_access_token: 'tok' });
  assert.equal(await off.mod.sendLeadConversionEvent({ tenantId: 't', lead: { id: 'l', meta_lead_id: 'm' }, eventName: 'QualifiedLead' }), 'skipped');
});

test('queue: not configured fails at once with a reason; errors retry then fail; success records sent_at', async () => {
  const run = async (sendResult, attempts) => {
    const updates = [];
    let claimed = false;
    const jobs = load('jobs/featureJobs.js', {
      axios: {}, '../services/features': {}, '../services/outgoingWebhooks': {}, '../utils/cryptoSecrets': {}, '../controllers/notificationController': {},
      '../config/db': { query: async (sql, p) => {
        if (sql.startsWith('UPDATE meta_capi_queue SET attempts')) { if (claimed) return { rows: [] }; claimed = true; return { rows: [{ id: 'q1', tenant_id: 't', lead_snapshot: {}, event_name: 'QualifiedLead', attempts, created_at: new Date() }] }; }
        updates.push(p); return { rows: [] };
      } },
      '../utils/metaCapi': { sendLeadConversionEvent: async () => sendResult },
    });
    await jobs.runCapi();
    return updates[0];
  };
  let u = await run('not_configured', 1);
  assert.equal(u[1], 'failed'); assert.match(u[3], /dataset ID or access token is missing/);
  u = await run('error', 2);
  assert.equal(u[1], 'pending'); assert.equal(u[2], 4);
  u = await run('error', 6);
  assert.equal(u[1], 'failed');
  u = await run('success', 1);
  assert.equal(u[1], 'success'); assert.equal(u[3], null);
});
