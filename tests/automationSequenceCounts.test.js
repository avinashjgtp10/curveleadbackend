// GET /automations/sequences returns per-sequence lead counts. The database is MOCKED; the SQL itself was checked on real PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let fail = false;
const db = require('../config/db');
db.query = async (sql, params) => {
  calls.push({ sql, params });
  if (fail) throw new Error('db down');
  // pg returns COUNT(*) as strings
  return { rows: [
    { id: 's1', name: 'Nurture', is_active: true, steps: [{ id: 'x' }], enrolled_total: '12', enrolled_active: '7', with_errors: '2', in_review: '1' },
    { id: 's2', name: 'Draft', is_active: false, steps: [], enrolled_total: '0', enrolled_active: '0', with_errors: '0', in_review: '0' },
    { id: 's3', name: 'Old backend row', is_active: false, steps: [] }, // no counts at all
  ] };
};
const ctrl = require('../controllers/automationController');
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

test('sequences come back with numeric lead counts', async () => {
  const r = res(); await ctrl.getSequences({ tenantId: 't1' }, r);
  assert.equal(r.code, 200);
  const [a, b, c] = r.body.sequences;
  assert.deepEqual([a.enrolled_total, a.enrolled_active, a.with_errors, a.in_review], [12, 7, 2, 1]);
  assert.deepEqual([b.enrolled_total, b.enrolled_active, b.with_errors, b.in_review], [0, 0, 0, 0]);
  assert.deepEqual([c.enrolled_total, c.with_errors], [0, 0]); // missing counts read as zero, never NaN
  assert.equal(a.steps.length, 1); assert.equal(a.name, 'Nurture');
});
test('the query is scoped to the tenant and counts only blocked, failed and uncertain as errors', async () => {
  calls.length = 0; await ctrl.getSequences({ tenantId: 'tenant-42' }, res());
  assert.deepEqual(calls[0].params, ['tenant-42']);
  assert.match(calls[0].sql, /WHERE tenant_id = \$1 GROUP BY sequence_id/);
  assert.match(calls[0].sql, /status IN \('blocked','failed','uncertain'\)/);
  assert.match(calls[0].sql, /status = 'human_review'/);
});
test('a database failure is a 500, not a crash', async () => {
  fail = true; const r = res(); await ctrl.getSequences({ tenantId: 't1' }, r); fail = false;
  assert.equal(r.code, 500);
});
