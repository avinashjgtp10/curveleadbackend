// The finance API layer: workspace flag (off by default), permissions, staff lead access, HTTP mapping, and the two
// protections in the lead controller (advance_received frozen once the ledger is on; leads with payments not deletable).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const T = '11111111-1111-1111-1111-111111111111', L = '22222222-2222-2222-2222-222222222222', U = '33333333-3333-3333-3333-333333333333', P = '44444444-4444-4444-4444-444444444444';
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

const loadWith = (file, mocks) => {
  const saved = {}; const paths = Object.keys(mocks).map((k) => [k, require.resolve(k)]);
  for (const [k, p] of paths) { saved[p] = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: mocks[k] }; }
  const f = require.resolve(file); delete require.cache[f];
  try { return require(f); } finally { delete require.cache[f]; for (const [, p] of paths) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } }
};

// ---- the workspace flag ---------------------------------------------------------------------------------------------------------
test('the ledger is OFF unless the workspace says on; unreadable settings mean off; the kill switch wins', async () => {
  const mk = (flag, fail = false) => loadWith('../utils/financeFlags', { '../config/db': { query: async () => { if (fail) throw new Error('db down'); return { rows: [{ flag }] }; } } });
  for (const [flag, want] of [[null, false], [undefined, false], ['off', false], ['on', true], [true, true], ['true', true], ['maybe', false], [1, false]]) assert.equal(await mk(flag).ledgerEnabled(T), want, String(flag));
  assert.equal(await mk('on', true).ledgerEnabled(T), false);
  process.env.FINANCE_LEDGER_KILL = '1';
  try { assert.equal(await mk('on').ledgerEnabled(T), false, 'kill switch'); } finally { delete process.env.FINANCE_LEDGER_KILL; }
});

test('the flag answer is cached briefly and requireLedger answers 404 feature_off when off', async () => {
  let calls = 0;
  const flags = loadWith('../utils/financeFlags', { '../config/db': { query: async () => { calls++; return { rows: [{ flag: 'on' }] }; } } });
  await flags.ledgerEnabled(T); await flags.ledgerEnabled(T); assert.equal(calls, 1);
  const off = loadWith('../utils/financeFlags', { '../config/db': { query: async () => ({ rows: [{ flag: null }] }) } });
  const r = res(); let next = false;
  await off.requireLedger({ tenantId: T }, r, () => { next = true; });
  assert.equal(r.code, 404); assert.deepEqual(r.data, { error: 'feature_off' }); assert.equal(next, false);
  const on = res(); await flags.requireLedger({ tenantId: T }, on, () => { next = true; }); assert.equal(next, true);
});

// ---- permissions --------------------------------------------------------------------------------------------------------------------
test('finance.view and finance.manage exist; staff have neither by default; admins have both', async () => {
  const perms = loadWith('../utils/permissions', { '../config/db': { query: async () => ({ rows: [] }) } });
  assert.ok(perms.PERMISSIONS['finance.view'] && perms.PERMISSIONS['finance.manage']);
  assert.ok(!perms.ROLE_DEFAULTS.staff.includes('finance.view') && !perms.ROLE_DEFAULTS.staff.includes('finance.manage'));
  for (const key of ['finance.view', 'finance.manage']) {
    assert.equal(await perms.hasPermission({ id: U, role: 'staff' }, key), false);
    assert.equal(await perms.hasPermission({ id: U, role: 'admin' }, key), true);
  }
  const granted = loadWith('../utils/permissions', { '../config/db': { query: async () => ({ rows: [{ granted: true }] }) } });
  assert.equal(await granted.hasPermission({ id: U, role: 'staff' }, 'finance.view'), true, 'an explicit per-user grant works');
});

test('every finance route is behind the flag and the right permission, and the router is mounted', () => {
  const routes = read('routes/finance.js');
  assert.match(routes, /router\.use\(authenticate, tenantContext, requireLedger\)/);
  const lines = routes.split('\n').filter((l) => /^router\.(get|post|patch|put|delete)\(/.test(l));
  assert.ok(lines.length >= 9);
  for (const l of lines) {
    const write = /^router\.(post|patch|put|delete)/.test(l);
    assert.match(l, write ? /requirePermission\('finance\.manage'\)/ : /requirePermission\('finance\.view'\)/, l);
  }
  assert.doesNotMatch(routes, /router\.delete/, 'there is no delete endpoint');
  assert.match(read('server.js'), /app\.use\('\/api\/finance', apiLimiter, require\('\.\/routes\/finance'\)\)/);
});

// ---- the controller -----------------------------------------------------------------------------------------------------------------------
const makeController = ({ leads = {}, payments = {}, svc = {} } = {}) => {
  const FinanceError = class extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); } };
  const db = { query: async (sql, p) => {
    if (/SELECT assigned_to FROM leads/.test(sql)) return { rows: leads[p[0]] && leads[p[0]].tenant === p[1] ? [{ assigned_to: leads[p[0]].assigned_to }] : [] };
    if (/SELECT lead_id FROM lead_payments/.test(sql)) return { rows: payments[p[0]] && payments[p[0]].tenant === p[1] ? [{ lead_id: payments[p[0]].lead_id }] : [] };
    throw new Error('unexpected SQL ' + sql.slice(0, 50));
  } };
  const ledger = { FinanceError, getLeadFinance: async () => ({ ok: 1 }), recordPayment: async () => ({ payment: { id: P }, replayed: false }), refund: async () => ({ entry: { id: 'r' }, replayed: false }),
    reverse: async () => ({ entry: { id: 'v' }, replayed: false }), complete: async () => ({ payment: {} }), cancel: async () => ({ payment: {} }), correct: async () => ({ payment: {} }), amendDetails: async () => ({ payment: {} }), getAudit: async () => [], ...svc };
  const permissions = { hasPermission: async (user, key) => user.role === 'admin' || (user.grants || []).includes(key) };
  return { ctrl: loadWith('../controllers/financeController', { '../config/db': db, '../services/finance/ledger': ledger, '../utils/permissions': permissions }), FinanceError };
};
const reqOf = (over = {}) => ({ tenantId: T, user: { id: U, role: 'admin' }, params: {}, query: {}, body: {}, get: () => undefined, ...over });
const world = { leads: { [L]: { tenant: T, assigned_to: U } }, payments: { [P]: { tenant: T, lead_id: L } } };

test('ids must be UUIDs and a lead of another workspace is a plain 404', async () => {
  const { ctrl } = makeController(world);
  let r = res(); await ctrl.getFinance(reqOf({ params: { id: 'abc' } }), r); assert.equal(r.code, 422);
  r = res(); await ctrl.getFinance(reqOf({ params: { id: L }, tenantId: '99999999-9999-9999-9999-999999999999' }), r); assert.equal(r.code, 404);
  r = res(); await ctrl.refundPayment(reqOf({ params: { id: P }, tenantId: '99999999-9999-9999-9999-999999999999' }), r); assert.equal(r.code, 404);
  r = res(); await ctrl.getFinance(reqOf({ params: { id: L } }), r); assert.equal(r.code, 200);
});

test('staff reach only their own leads\' money; admins reach any', async () => {
  const { ctrl } = makeController(world);
  const other = { ...reqOf({ params: { id: L } }), user: { id: '55555555-5555-5555-5555-555555555555', role: 'staff' } };
  let r = res(); await ctrl.getFinance(other, r); assert.equal(r.code, 404);
  r = res(); await ctrl.createPayment({ ...other, body: { amount: 1 } }, r); assert.equal(r.code, 404);
  r = res(); await ctrl.refundPayment({ ...other, params: { id: P } }, r); assert.equal(r.code, 404);
  const own = { ...reqOf({ params: { id: L } }), user: { id: U, role: 'staff' } };
  r = res(); await ctrl.getFinance(own, r); assert.equal(r.code, 200);
  r = res(); await ctrl.audit({ ...other, query: {} }, r); assert.equal(r.code, 403, 'staff cannot read the whole audit trail');
});

test('the lead finance response tells the screen whether the user may change payments', async () => {
  const { ctrl } = makeController(world);
  let r = res(); await ctrl.getFinance(reqOf({ params: { id: L } }), r); assert.equal(r.data.can_manage, true);
  r = res(); await ctrl.getFinance({ ...reqOf({ params: { id: L } }), user: { id: U, role: 'staff', grants: ['finance.view'] } }, r); assert.equal(r.data.can_manage, false);
  r = res(); await ctrl.getFinance({ ...reqOf({ params: { id: L } }), user: { id: U, role: 'staff', grants: ['finance.manage'] } }, r); assert.equal(r.data.can_manage, true);
});

test('create: 201 for a new payment, 200 for a replay; the key comes from the header or the body; only literal true confirms a duplicate', async () => {
  let seen; let replayed = false;
  const { ctrl } = makeController({ ...world, svc: { recordPayment: async (a) => { seen = a; return { payment: { id: P }, replayed }; } } });
  const body = { amount: '100', currency: 'inr', paid_on: '2026-10-01', confirm_duplicate: 'true', idempotency_key: 'body-key-0001' };
  let r = res(); await ctrl.createPayment(reqOf({ params: { id: L }, body }), r);
  assert.equal(r.code, 201); assert.equal(seen.idempotencyKey, 'body-key-0001'); assert.equal(seen.confirmDuplicate, false, '"true" as text does not confirm'); assert.equal(seen.userId, U);
  replayed = true; r = res();
  await ctrl.createPayment(reqOf({ params: { id: L }, body: { ...body, confirm_duplicate: true }, get: (h) => (h.toLowerCase() === 'idempotency-key' ? 'header-key-0001' : undefined) }), r);
  assert.equal(r.code, 200); assert.equal(r.data.replayed, true); assert.equal(seen.idempotencyKey, 'header-key-0001'); assert.equal(seen.confirmDuplicate, true);
});

test('service errors become their status, message and code; unexpected errors never leak details', async () => {
  const { ctrl, FinanceError } = makeController({ ...world, svc: {
    recordPayment: async () => { throw new FinanceError(409, 'possible_duplicate', 'Already recorded.', { existing_payment_id: P }); },
    refund: async () => { throw new Error('select * from secrets: password=hunter2'); },
  } });
  let r = res(); await ctrl.createPayment(reqOf({ params: { id: L }, body: {} }), r);
  assert.deepEqual([r.code, r.data.code, r.data.existing_payment_id, r.data.error], [409, 'possible_duplicate', P, 'Already recorded.']);
  r = res(); const quiet = console.error; console.error = () => {};
  try { await ctrl.refundPayment(reqOf({ params: { id: P } }), r); } finally { console.error = quiet; }
  assert.equal(r.code, 500); assert.doesNotMatch(JSON.stringify(r.data), /password|hunter2|secrets/);
});

test('refund, reverse, complete, cancel, correct and amend pass the actor and request fields to the service', async () => {
  const calls = {};
  const rec = (name) => async (a) => { calls[name] = a; return name === 'refund' || name === 'reverse' ? { entry: {}, replayed: false } : { payment: {} }; };
  const { ctrl } = makeController({ ...world, svc: { refund: rec('refund'), reverse: rec('reverse'), complete: rec('complete'), cancel: rec('cancel'), correct: rec('correct'), amendDetails: rec('amendDetails') } });
  const req = (body) => reqOf({ params: { id: P }, body: { idempotency_key: 'idem-key-0001', ...body } });
  await ctrl.refundPayment(req({ amount: 5, reason: 'r1' }), res()); await ctrl.reversePayment(req({ reason: 'r2' }), res()); await ctrl.completePayment(req({ paid_on: '2026-10-02' }), res());
  await ctrl.cancelPayment(req({ reason: 'r3' }), res()); await ctrl.correctPayment(req({ amount: 9, reason: 'r4' }), res()); await ctrl.amendPayment(req({ reason: 'r5', notes: 'n' }), res());
  assert.deepEqual([calls.refund.amount, calls.refund.reason, calls.refund.userId, calls.refund.tenantId, calls.refund.paymentId], [5, 'r1', U, T, P]);
  assert.equal(calls.reverse.reason, 'r2'); assert.equal(calls.complete.paidOn, '2026-10-02'); assert.equal(calls.correct.amount, 9); assert.equal(calls.amendDetails.patch.notes, 'n');
});

// ---- lead controller protections ----------------------------------------------------------------------------------------------------------
function loadLeads(db, financeFlags) {
  const module = { exports: {} };
  const quiet = async () => {};
  vm.runInNewContext(read('controllers/leadController.js'), {
    module, exports: module.exports, console, Date, JSON, Set, Map, Promise, Intl, Math, Number, String, Array, Object, process: { env: {} }, setTimeout, Buffer,
    require: (k) => ({ '../config/db': db, '../utils/leadFieldInput': require('../utils/leadFieldInput'), '../utils/dataQuality': require('../utils/dataQuality'), '../utils/financeFlags': financeFlags,
      '../utils/automationTriggers': { checkStageChangeTriggers: quiet, checkLeadStatusTriggers: quiet, checkNewLeadTriggers: quiet }, '../utils/leadResponse': { recordFirstResponse: quiet },
      '../utils/deletedLeads': { tombstoneMetaLead: quiet } }[k] || {}),
  });
  return module.exports;
}
const leadDb = (prevAdvance = 0) => ({ query: async (sql) => {
  if (/SELECT stage, lead_status, assigned_to, name, advance_received FROM leads/.test(sql)) return { rows: [{ stage: 'Won', lead_status: null, assigned_to: null, name: 'T', advance_received: prevAdvance }] };
  if (/FROM lead_stages/.test(sql)) return { rows: [{ is_won: true, is_lost: false }] };
  if (/^\s*UPDATE leads SET/.test(sql)) return { rows: [{ id: L, name: 'T' }] };
  return { rows: [] };
} });

test('once the ledger is on, editing advance_received is a 409 that points to payments; unchanged values and ledger-off behave as before', async () => {
  const on = { ledgerEnabled: async () => true }; const off = { ledgerEnabled: async () => false };
  let r = res(); await loadLeads(leadDb(0), on).updateLead({ params: { id: L }, tenantId: T, user: { id: U, role: 'admin' }, body: { advance_received: 5000 } }, r);
  assert.equal(r.code, 409); assert.equal(r.data.code, 'use_payments'); assert.match(r.data.error, /Finance section/);
  r = res(); await loadLeads(leadDb(5000), on).updateLead({ params: { id: L }, tenantId: T, user: { id: U, role: 'admin' }, body: { advance_received: '5000', notes: 'x' } }, r);
  assert.equal(r.code, 200, 'the edit form resends the same value: no conflict');
  r = res(); await loadLeads(leadDb(0), off).updateLead({ params: { id: L }, tenantId: T, user: { id: U, role: 'admin' }, body: { advance_received: 5000 } }, r);
  assert.equal(r.code, 200, 'ledger off: the legacy field works exactly as before');
});

test('deleting a lead that has payments is a clear 409; other failures stay a generic 500', async () => {
  const fk = Object.assign(new Error('update or delete on table "leads" violates foreign key constraint "lead_payments_lead_id_fkey" on table "lead_payments"'), { code: '23001', constraint: 'lead_payments_lead_id_fkey' });
  const quiet = console.error; console.error = () => {};
  try {
    for (const [fn, req] of [['deleteLead', { params: { id: L } }], ['bulkDelete', { body: { ids: [L] } }]]) {
      let r = res(); await loadLeads({ query: async () => { throw fk; } }, {})[fn]({ tenantId: T, user: { id: U }, ...req }, r);
      assert.equal(r.code, 409, fn); assert.equal(r.data.code, 'has_payments'); assert.match(r.data.error, /Mark it as Lost to archive/);
      r = res(); await loadLeads({ query: async () => { throw new Error('boom'); } }, {})[fn]({ tenantId: T, user: { id: U }, ...req }, r);
      assert.equal(r.code, 500, fn);
    }
  } finally { console.error = quiet; }
});
