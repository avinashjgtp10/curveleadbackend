// A blank number/date/id in the lead edit form must never fail the save (production error seen on 2026-10-12:
// invalid input syntax for type numeric: ""), and a nonsense amount is a clear 422, not a 500.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { cleanLeadInput } = require('../utils/leadFieldInput');

test('blank amounts mean 0, blank ids and dates mean none, real values pass through as numbers', () => {
  const b = { deal_value: '', advance_received: '  ', assigned_to: '', campaign_id: ' ', expected_close_date: '', notes: '' };
  assert.equal(cleanLeadInput(b), null);
  assert.deepEqual(b, { deal_value: 0, advance_received: 0, assigned_to: null, campaign_id: null, expected_close_date: null, notes: '' });
  const v = { deal_value: '20000', advance_received: 5000.5, assigned_to: 'a1', expected_close_date: '2026-10-20' };
  assert.equal(cleanLeadInput(v), null);
  assert.deepEqual(v, { deal_value: 20000, advance_received: 5000.5, assigned_to: 'a1', expected_close_date: '2026-10-20' });
  const n = { deal_value: null }; cleanLeadInput(n); assert.equal(n.deal_value, 0);
});

test('fields that were not sent stay untouched', () => {
  const b = { stage: 'Won' }; cleanLeadInput(b); assert.deepEqual(b, { stage: 'Won' });
});

test('a nonsense or out-of-range amount is rejected with a message, not passed to SQL', () => {
  for (const bad of ['abc', '1e999', -5, '-1', 1e12, NaN, {}, []]) {
    const b = { deal_value: bad };
    assert.match(cleanLeadInput(b), /Deal value must be a valid amount/, String(bad));
  }
  assert.match(cleanLeadInput({ advance_received: 'x' }), /Advance received must be a valid amount/);
});

// ---- through the real updateLead handler -------------------------------------------------------------------------------
function loadController(db) {
  const module = { exports: {} };
  const quiet = async () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'controllers/leadController.js'), 'utf8'), {
    module, exports: module.exports, console, Date, JSON, Set, Map, Promise, Intl, Math, Number, String, Array, Object, process: { env: {} }, setTimeout, Buffer,
    require: (k) => ({
      '../config/db': db, '../utils/leadFieldInput': require('../utils/leadFieldInput'), '../utils/dataQuality': require('../utils/dataQuality'),
      '../utils/automationTriggers': { checkStageChangeTriggers: quiet, checkLeadStatusTriggers: quiet, checkNewLeadTriggers: quiet },
      '../utils/leadResponse': { recordFirstResponse: quiet },
    }[k] || {}),
  });
  return module.exports;
}
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

test('updateLead saves "Won + price" when the form also sends blank advance, owner and close date', async () => {
  const seen = [];
  const db = { query: async (sql, params) => {
    seen.push({ sql: sql.replace(/\s+/g, ' '), params });
    if (/SELECT stage, lead_status, assigned_to, name, advance_received FROM leads/.test(sql)) return { rows: [{ stage: 'New', lead_status: null, assigned_to: null, name: 'T', advance_received: 0 }] };
    if (/FROM lead_stages/.test(sql)) return { rows: [{ is_won: true, is_lost: false, meta_event_name: null }] };
    if (/^\s*UPDATE leads SET/.test(sql)) return { rows: [{ id: 'L1', name: 'T', stage: 'Won' }] };
    return { rows: [] };
  } };
  const r = res();
  await loadController(db).updateLead({ params: { id: 'L1' }, tenantId: 't', user: { id: 'u', role: 'admin' },
    body: { stage: 'Won', deal_value: '20000', advance_received: '', assigned_to: '', expected_close_date: '', notes: 'x' } }, r);
  assert.equal(r.code, 200, JSON.stringify(r.data));
  const upd = seen.find((c) => /^UPDATE leads SET/.test(c.sql));
  assert.ok(!upd.params.includes(''), 'no empty string reaches SQL');
  assert.match(upd.sql, /won_at = COALESCE\(won_at, NOW\(\)\)/);
  assert.ok(upd.params.includes(20000) && upd.params.includes(0) && upd.params.includes(null));
});

test('updateLead answers 422 for a nonsense amount without touching the database', async () => {
  const seen = []; const db = { query: async (sql) => { seen.push(sql); return { rows: [] }; } };
  const r = res();
  await loadController(db).updateLead({ params: { id: 'L1' }, tenantId: 't', user: { id: 'u' }, body: { deal_value: 'abc' } }, r);
  assert.equal(r.code, 422); assert.match(r.data.error, /Deal value/);
  assert.ok(!seen.some((s) => /UPDATE leads/.test(s)));
});
