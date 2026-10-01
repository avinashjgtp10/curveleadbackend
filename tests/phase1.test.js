const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dateTime = require('../utils/dateTime');
function load(file, dependencies = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, process: { env: {} }, console: { error() {} },
    setTimeout: fn => setTimeout(fn, 0), Buffer, URL,
    require: name => {
      if (name in dependencies) return dependencies[name];
      if (name === 'crypto') return require('crypto');
      if (name === '../utils/dateTime') return dateTime;
      return {};
    },
  }, { filename: file });
  return module.exports;
}
function response() { return { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } }; }
const req = { tenantId: 'tenant-a', user: { role: 'staff', id: 'staff-a' }, query: {}, params: {}, body: {} };
test('500 UUID body lookup succeeds, excessive/invalid lists return 422 without querying', async () => {
  let calls = 0;
  const ctrl = load('controllers/automationEnrollmentController.js', { '../config/db': { query: async () => { calls++; return { rows: [] }; } } });
  const ids = Array(500).fill('11111111-1111-1111-1111-111111111111');
  let res = response(); await ctrl.getEnrollments({ ...req, method: 'POST', body: { lead_ids: ids } }, res);
  assert.equal(res.code, 200); assert.equal(calls, 1);
  for (const lead_ids of [[...ids, ids[0]], ['bad'], null, 'bad']) {
    res = response(); await ctrl.getEnrollments({ ...req, method: 'POST', body: { lead_ids } }, res); assert.equal(res.code, 422);
  }
  assert.equal(calls, 1);
  res = response(); await ctrl.getEnrollments({ ...req, method: 'GET', query: { lead_ids: ids[0] } }, res); assert.equal(res.code, 200);
});
test('automation pagination preserves true server totals and staff scope', async () => {
  const ctrl = load('controllers/automationEnrollmentController.js', { '../config/db': { query: async (sql, params) => {
    assert.match(sql, /l\.tenant_id = \$1 AND l\.assigned_to = \$2/);
    assert.match(sql, /FROM scoped/); assert.match(sql, /LIMIT \$4 OFFSET \$5/);
    assert.deepEqual(Array.from(params), ['tenant-a', 'staff-a', '%Sunita%', 25, 25]);
    return { rows: [{ leads: [], total: 1200, summary: { total: 1500 }, steps: [] }] };
  } } });
  const res = response(); await ctrl.getAutomationLeads({ ...req, query: { page: 2, limit: 25, search: 'Sunita' } }, res);
  assert.equal(res.code, 200); assert.equal(res.data.pagination.total, 1200); assert.equal(res.data.summary.total, 1500);
  for (const page of ['bad', 0, -1, 1.5]) { const bad = response(); await ctrl.getAutomationLeads({ ...req, query: { page } }, bad); assert.equal(bad.code, 422); }
});
test('billing catalog reads without Razorpay configuration and logs query failure as an error', async () => {
  const ctrl = load('controllers/paymentController.js', { '../config/db': { query: async () => ({ rows: [{ id: 'p', name: 'Starter', price: 999 }] }) } });
  const res = response(); await ctrl.getPlans(req, res); assert.equal(res.code, 200); assert.equal(res.data.plans[0].amount, 99900); assert.equal(res.data.razorpayKeyId, null);
  const bad = load('controllers/paymentController.js', { '../config/db': { query: async () => { throw new Error('database unavailable'); } } });
  const fail = response(); await bad.getPlans(req, fail); assert.equal(fail.code, 500);
});
test('empty playbook is 200/null; a database outage is not misreported as no playbook', async () => {
  let fail = false;
  const ctrl = load('controllers/playbookController.js', { '../config/db': { query: async () => { if (fail) throw new Error('offline'); return { rows: [] }; } } });
  const res = response(); await ctrl.getPlaybook(req, res); assert.equal(res.code, 200); assert.equal(res.data.playbook, null);
  fail = true; const bad = response(); await ctrl.getPlaybook(req, bad); assert.equal(bad.code, 500);
});
test('appointment create/update reject null, epoch, malformed and offset-free dates before writes', async () => {
  let calls = 0;
  const deps = { '../config/db': { query: async () => { calls++; throw new Error('unexpected query'); } } };
  const create = load('controllers/leadController.js', deps);
  const update = load('controllers/followupController.js', deps);
  for (const value of [null, 0, '', 'bad', '1970-01-01T00:00:00Z', '2026-10-07T19:00']) {
    for (const handler of [create.addFollowup, update.updateFollowup]) {
      const res = response(); await handler({ ...req, body: { next_followup_at: value } }, res); assert.ok([400, 422].includes(res.code));
    }
  }
  assert.equal(calls, 0);
  assert.equal(dateTime.validAppointmentDate('2026-10-07T13:30:00Z'), true);
  assert.match(dateTime.formatDateTime('2026-10-07T13:30:00Z'), /7:00/);
});
test('Meta template timeout retries then uses last-good data; token change cannot reuse it', async () => {
  let failing = false, calls = 0, now = Date.now();
  // Service cache clock runs in its VM; age the entry by issuing a synthetic Date class.
  const source = fs.readFileSync(path.join(__dirname, '../services/whatsappService.js'), 'utf8');
  const module = { exports: {} };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, { module, Date: Clock, process: { env: {} }, console: { error() {} }, setTimeout: fn => setTimeout(fn, 0), require: name => name === 'crypto' ? require('crypto') : name === 'axios' ? { get: async (url, options) => {
    calls++; assert.equal(options.timeout, 5000); if (failing) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); return { data: { data: [{ name: 'hello' }] } };
  } } : {} });
  const fn = module.exports.listMessageTemplates;
  assert.equal((await fn('waba', 'token-a')).success, true);
  failing = true; now += 61000;
  const stale = await fn('waba', 'token-a'); assert.equal(stale.stale, true); assert.equal(stale.templates[0].name, 'hello'); assert.equal(calls, 3);
  assert.equal((await fn('waba', 'token-b')).success, false);
  now += 86400000; assert.equal((await fn('waba', 'token-a')).success, false);
});

test('pg timestamp parser and connection timezone are UTC regardless of host timezone', () => {
  let parser, config;
  class Pool { constructor(options) { config = options; } on() {} }
  load('config/db.js', { pg: { Pool, types: { setTypeParser(oid, fn) { assert.equal(oid, 1114); parser = fn; } } }, dotenv: { config() {} } });
  assert.equal(config.options, '-c timezone=UTC');
  assert.equal(parser('2026-10-07 13:30:00').toISOString(), '2026-10-07T13:30:00.000Z');
});

test('legacy schedule repair parses UTC text conservatively and preserves demo links', () => {
  const { parseLegacySchedule } = require('../scripts/backfillScheduledActivity');
  assert.deepEqual(parseLegacySchedule('Scheduled for 7 Oct 2026, 1:30 pm'), { scheduled_at: '2026-10-07T13:30:00.000Z', meeting_url: null });
  assert.equal(parseLegacySchedule('Scheduled for 7 Oct 2026, 1:30 pm · Link: https://example.com').meeting_url, 'https://example.com');
  assert.equal(parseLegacySchedule('Scheduled for 31 Feb 2026, 1:30 pm'), null);
  assert.equal(parseLegacySchedule('unknown old description'), null);
});

test('rescheduling normalizes offset input before writing UTC timestamp columns', async () => {
  let stored;
  const ctrl = load('controllers/followupController.js', { '../config/db': { query: async (sql, values) => { stored = values[2]; return { rows: [{ id: 'f' }] }; } } });
  const res = response();
  await ctrl.updateFollowup({ ...req, params: { id: 'f' }, body: { next_followup_at: '2026-10-07T19:00:00+05:30' } }, res);
  assert.equal(res.code, 200); assert.equal(stored, '2026-10-07T13:30:00.000Z');
});
