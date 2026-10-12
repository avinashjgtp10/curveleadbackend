// The ledger SERVICE: idempotent retries, the soft duplicate check, readable errors, corrections as reversal + new
// payment, audited detail changes. The money rules themselves are enforced by the database and proven in
// tests/phase1LedgerSql.test.js; here an in-memory ledger stands in for it.
const test = require('node:test');
const assert = require('node:assert/strict');

const T = '11111111-1111-1111-1111-111111111111', L = '22222222-2222-2222-2222-222222222222', U = '33333333-3333-3333-3333-333333333333';

const fakeLedger = ({ dbError = null } = {}) => {
  const rows = []; const ctx = []; const state = { txn: 0, commits: 0, rollbacks: 0 }; let seq = 0;
  const id = () => `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`;
  const clone = (r) => ({ ...r });
  const client = { query: async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (dbError && /^INSERT INTO lead_payments/.test(sql)) throw dbError;
    if (/set_config\('curvelead\.actor'/.test(sql)) { ctx.push({ actor: p[0], reason: p[1], edit: p[2] }); return { rows: [] }; }
    if (/idempotency_key = \$2/.test(sql)) return { rows: rows.filter((r) => r.tenant_id === p[0] && r.idempotency_key === p[1]).map(clone) };
    if (/FROM lead_payments WHERE id = \$1 AND tenant_id = \$2/.test(sql)) return { rows: rows.filter((r) => r.id === p[0] && r.tenant_id === p[1]).map(clone) };
    if (/AND kind = 'payment' AND status IN \('pending','completed'\) AND amount = \$3/.test(sql)) {
      return { rows: rows.filter((r) => r.tenant_id === p[0] && r.lead_id === p[1] && r.kind === 'payment' && Number(r.amount) === Number(p[2]) && r.currency === p[3] && r.paid_on === p[4]).map((r) => ({ id: r.id })) };
    }
    if (/SELECT COALESCE\(SUM\(amount\), 0\) AS s FROM lead_payments WHERE parent_id/.test(sql)) {
      return { rows: [{ s: rows.filter((r) => r.parent_id === p[0] && ['refund', 'reversal'].includes(r.kind) && ['pending', 'completed'].includes(r.status)).reduce((a, r) => a + Number(r.amount), 0) }] };
    }
    if (/^INSERT INTO lead_payments/.test(sql)) {
      if (rows.some((r) => r.tenant_id === p[0] && r.idempotency_key === p[16])) return { rows: [] };
      const row = { id: id(), tenant_id: p[0], lead_id: p[1], kind: p[2], status: p[3], amount: Number(p[4]).toFixed(2), currency: p[5], adjustment_direction: p[6], parent_id: p[7], replaces_id: p[8],
        paid_on: p[9], paid_on_basis: p[10], estimated_paid_on: p[11], method: p[12], reference: p[13], notes: p[14], reason: p[15], idempotency_key: p[16], source: p[17], created_by: p[18] };
      rows.push(row); return { rows: [clone(row)] };
    }
    if (/^UPDATE lead_payments SET status = \$3/.test(sql)) {
      const r = rows.find((x) => x.id === p[0] && x.tenant_id === p[1] && x.status === 'pending');
      if (!r) return { rows: [] };
      r.status = p[2]; if (p[3]) r.paid_on = p[3]; return { rows: [clone(r)] };
    }
    if (/^UPDATE lead_payments SET (paid_on|paid_on_basis|method|reference|notes)/.test(sql)) {
      const r = rows.find((x) => x.id === p[0] && x.tenant_id === p[1]);
      const cols = [...sql.matchAll(/(\w+) = \$(\d+)/g)].filter((m) => Number(m[2]) > 2);
      for (const m of cols) r[m[1]] = p[Number(m[2]) - 1];
      return { rows: [clone(r)] };
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 90)}`);
  } };
  const db = { rows, ctx, state, client, query: client.query,
    transaction: async (fn) => { state.txn++; const snap = JSON.stringify(rows); try { const r = await fn(client); state.commits++; return r; } catch (e) { state.rollbacks++; rows.length = 0; rows.push(...JSON.parse(snap)); throw e; } } };
  return db;
};
const load = (db) => {
  const dbPath = require.resolve('../config/db'); const lp = require.resolve('../services/finance/ledger');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  delete require.cache[lp];
  try { return require(lp); } finally { delete require.cache[lp]; if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath]; }
};
const pay = (svc, over = {}) => svc.recordPayment({ tenantId: T, leadId: L, userId: U, amount: 5000, currency: 'inr', paidOn: '2026-10-01', idempotencyKey: 'key-0001-aaaa', ...over });

test('recording a payment normalizes input, runs in one transaction and sets the audit context', async () => {
  const db = fakeLedger(); const svc = load(db);
  const r = await pay(svc, { amount: '5000.456', method: ' UPI ', reference: ' TXN-1 ' });
  assert.equal(r.replayed, false);
  assert.deepEqual([r.payment.amount, r.payment.currency, r.payment.method, r.payment.reference, r.payment.status], ['5000.46', 'INR', 'UPI', 'TXN-1', 'completed']);
  assert.equal(db.state.txn, 1); assert.equal(db.ctx[0].actor, U);
});

test('input is validated before anything is written', async () => {
  const db = fakeLedger(); const svc = load(db);
  const cases = [[{ amount: 0 }, 'invalid_amount'], [{ amount: -1 }, 'invalid_amount'], [{ amount: 'abc' }, 'invalid_amount'], [{ amount: 1e12 }, 'invalid_amount'], [{ amount: [] }, 'invalid_amount'],
    [{ currency: 'rupees' }, 'invalid_currency'], [{ currency: '' }, 'invalid_currency'], [{ paidOn: '10/01/2026' }, 'invalid_date'], [{ paidOn: null }, 'paid_on_required'],
    [{ idempotencyKey: 'short' }, 'idempotency_key_required'], [{ idempotencyKey: undefined }, 'idempotency_key_required'], [{ status: 'failed' }, 'invalid_status'], [{ paidOnBasis: 'maybe' }, 'invalid_date_basis']];
  for (const [over, code] of cases) await assert.rejects(pay(svc, over), (e) => e.code === code && e.status >= 400, `${JSON.stringify(over)} -> ${code}`);
  assert.equal(db.rows.length, 0);
  assert.equal((await pay(svc, { paidOn: null, paidOnBasis: 'unknown', idempotencyKey: 'key-unknown-1' })).payment.paid_on_basis, 'unknown', 'a migrated/undated payment is allowed when labelled unknown');
});

test('a retry with the same Idempotency-Key returns the original; the same key for a different payment is a 409', async () => {
  const db = fakeLedger(); const svc = load(db);
  const first = await pay(svc);
  const retry = await pay(svc);
  assert.equal(retry.replayed, true); assert.equal(retry.payment.id, first.payment.id); assert.equal(db.rows.length, 1);
  await assert.rejects(pay(svc, { amount: 6000 }), (e) => e.status === 409 && e.code === 'idempotency_key_reused');
  await assert.rejects(pay(svc, { leadId: '99999999-9999-9999-9999-999999999999' }), (e) => e.code === 'idempotency_key_reused');
  assert.equal(db.rows.length, 1);
});

test('the same lead, amount, currency and date needs an explicit confirmation, which is then audited', async () => {
  const db = fakeLedger(); const svc = load(db);
  const first = await pay(svc);
  await assert.rejects(pay(svc, { idempotencyKey: 'key-0002-bbbb' }), (e) => e.status === 409 && e.code === 'possible_duplicate' && e.existing_payment_id === first.payment.id);
  const again = await pay(svc, { idempotencyKey: 'key-0002-bbbb', confirmDuplicate: true });
  assert.notEqual(again.payment.id, first.payment.id);
  assert.match(db.ctx[db.ctx.length - 1].reason, /possible-duplicate warning was confirmed/);
  await pay(svc, { idempotencyKey: 'key-0003-cccc', amount: 5001 }); // a different amount is not a duplicate
  assert.equal(db.rows.length, 3);
});

test('database rule violations become readable errors with the right HTTP status', async () => {
  const cases = [['LEAD_MERGED: this lead was merged', 409, 'lead_merged'], ['LEAD_NOT_FOUND: no such lead', 404, 'lead_not_found'], ['OVER_REFUND: too much (100.00)', 409, 'amount_exceeds_remaining'],
    ['CURRENCY_MISMATCH: use INR', 422, 'currency_mismatch'], ['REVERSAL_AMOUNT: full amount', 409, 'reversal_must_cover_remaining'], ['AUDITED_ONLY: use a correction', 409, 'audited_only']];
  for (const [message, status, code] of cases) {
    const svc = load(fakeLedger({ dbError: new Error(message) }));
    await assert.rejects(pay(svc), (e) => e.status === status && e.code === code && !/^[A-Z_]+: /.test(e.message), message);
  }
  const ref = Object.assign(new Error('duplicate key value violates unique constraint "lead_payments_reference_uq"'), { code: '23505', constraint: 'lead_payments_reference_uq' });
  await assert.rejects(pay(load(fakeLedger({ dbError: ref }))), (e) => e.status === 409 && e.code === 'duplicate_reference');
  const chk = Object.assign(new Error('violates check constraint'), { code: '23514' });
  await assert.rejects(pay(load(fakeLedger({ dbError: chk }))), (e) => e.status === 422 && e.code === 'invalid_entry');
  const unknown = new Error('connection reset');
  await assert.rejects(pay(load(fakeLedger({ dbError: unknown }))), (e) => e === unknown, 'unexpected errors pass through untouched');
});

test('a failed write rolls the whole transaction back', async () => {
  const db = fakeLedger({ dbError: new Error('OVER_REFUND: nope') }); const svc = load(db);
  await assert.rejects(pay(svc)); assert.equal(db.state.rollbacks, 1); assert.equal(db.state.commits, 0);
});

test('refund: needs a reason, copies the payment\'s currency and lead, and is idempotent', async () => {
  const db = fakeLedger(); const svc = load(db);
  const p = (await pay(svc)).payment;
  await assert.rejects(svc.refund({ tenantId: T, paymentId: p.id, userId: U, amount: 100, reason: '', idempotencyKey: 'refund-key-1' }), (e) => e.code === 'reason_required');
  await assert.rejects(svc.refund({ tenantId: T, paymentId: '99999999-9999-9999-9999-999999999999', userId: U, amount: 100, reason: 'customer asked', idempotencyKey: 'refund-key-1' }), (e) => e.status === 404);
  const r = await svc.refund({ tenantId: T, paymentId: p.id, userId: U, amount: 2000, reason: 'customer asked', idempotencyKey: 'refund-key-1' });
  assert.deepEqual([r.entry.kind, r.entry.amount, r.entry.currency, r.entry.lead_id, r.entry.parent_id], ['refund', '2000.00', 'INR', L, p.id]);
  const retry = await svc.refund({ tenantId: T, paymentId: p.id, userId: U, amount: 2000, reason: 'customer asked', idempotencyKey: 'refund-key-1' });
  assert.equal(retry.replayed, true); assert.equal(db.rows.length, 2);
  await assert.rejects(svc.refund({ tenantId: T, paymentId: p.id, userId: U, amount: 3000, reason: 'x y z', idempotencyKey: 'refund-key-1' }), (e) => e.code === 'idempotency_key_reused');
  assert.equal((await svc.refund({ tenantId: '44444444-4444-4444-4444-444444444444', paymentId: p.id, userId: U, amount: 1, reason: 'abc', idempotencyKey: 'refund-key-9' }).catch((e) => e)).status, 404, 'another workspace cannot see the payment');
});

test('reverse: covers exactly what is left after refunds, once', async () => {
  const db = fakeLedger(); const svc = load(db);
  const p = (await pay(svc, { amount: 1000 })).payment;
  await svc.refund({ tenantId: T, paymentId: p.id, userId: U, amount: 300, reason: 'partial', idempotencyKey: 'refund-key-2' });
  const rev = await svc.reverse({ tenantId: T, paymentId: p.id, userId: U, reason: 'bounced cheque', idempotencyKey: 'reverse-key-1' });
  assert.deepEqual([rev.entry.kind, rev.entry.amount], ['reversal', '700.00']);
  await assert.rejects(svc.reverse({ tenantId: T, paymentId: p.id, userId: U, reason: 'again please', idempotencyKey: 'reverse-key-2' }), (e) => e.code === 'nothing_to_reverse');
});

test('a correction is a reversal PLUS a new payment, atomic, linked, and a retry changes nothing', async () => {
  const db = fakeLedger(); const svc = load(db);
  const wrong = (await pay(svc, { amount: 5000 })).payment;
  const out = await svc.correct({ tenantId: T, paymentId: wrong.id, userId: U, amount: 500, reason: 'typed 5000 instead of 500', idempotencyKey: 'correct-key-1' });
  assert.equal(out.reversal.kind, 'reversal'); assert.equal(out.reversal.amount, '5000.00');
  assert.deepEqual([out.payment.kind, out.payment.amount, out.payment.replaces_id], ['payment', '500.00', wrong.id]);
  assert.equal(db.rows.length, 3, 'the original stays visible');
  const before = db.state.txn;
  const retry = await svc.correct({ tenantId: T, paymentId: wrong.id, userId: U, amount: 500, reason: 'typed 5000 instead of 500', idempotencyKey: 'correct-key-1' });
  assert.equal(retry.replayed, true); assert.equal(db.rows.length, 3); assert.equal(db.state.txn, before + 1);
  await assert.rejects(svc.correct({ tenantId: T, paymentId: out.reversal.id, userId: U, amount: 1, reason: 'abc', idempotencyKey: 'correct-key-2' }), (e) => e.code === 'payment_not_completed', 'only a completed payment can be corrected');
});

test('a correction that fails half-way leaves nothing behind', async () => {
  const db = fakeLedger(); const svc = load(db);
  const wrong = (await pay(svc, { amount: 5000 })).payment;
  const real = db.client.query;
  db.client.query = async (sql, p) => { if (/^INSERT INTO lead_payments/.test(sql.trim()) && p[2] === 'payment') throw new Error('CURRENCY_MISMATCH: boom'); return real(sql, p); };
  await assert.rejects(svc.correct({ tenantId: T, paymentId: wrong.id, userId: U, amount: 500, reason: 'typo here', idempotencyKey: 'correct-key-3' }), (e) => e.code === 'currency_mismatch');
  assert.equal(db.rows.length, 1, 'the reversal was rolled back with the failed payment');
});

test('pending entries can be completed (with a date) or cancelled; a completed one never can', async () => {
  const db = fakeLedger(); const svc = load(db);
  const pend = (await pay(svc, { status: 'pending', paidOn: null, idempotencyKey: 'pending-key-1' })).payment;
  const done = await svc.complete({ tenantId: T, paymentId: pend.id, userId: U, paidOn: '2026-10-05' });
  assert.deepEqual([done.payment.status, done.payment.paid_on], ['completed', '2026-10-05']);
  await assert.rejects(svc.cancel({ tenantId: T, paymentId: pend.id, userId: U }), (e) => e.status === 409 && e.code === 'not_pending' && /reversed, never cancelled/.test(e.message));
  const p2 = (await pay(svc, { status: 'pending', paidOn: null, idempotencyKey: 'pending-key-2', amount: 10 })).payment;
  assert.equal((await svc.cancel({ tenantId: T, paymentId: p2.id, userId: U })).payment.status, 'cancelled');
  await assert.rejects(svc.complete({ tenantId: T, paymentId: '99999999-9999-9999-9999-999999999999', userId: U, paidOn: '2026-10-05' }), (e) => e.status === 404);
});

test('details of a counted payment change only with a reason and the audited-edit flag; pending ones are free', async () => {
  const db = fakeLedger(); const svc = load(db);
  const p = (await pay(svc, { notes: 'first' })).payment;
  await assert.rejects(svc.amendDetails({ tenantId: T, paymentId: p.id, userId: U, patch: { notes: 'edited' } }), (e) => e.code === 'reason_required');
  await assert.rejects(svc.amendDetails({ tenantId: T, paymentId: p.id, userId: U, reason: 'because', patch: {} }), (e) => e.code === 'nothing_to_change');
  const out = await svc.amendDetails({ tenantId: T, paymentId: p.id, userId: U, reason: 'typo in the note', patch: { notes: 'edited', paidOn: '2026-09-30' } });
  assert.deepEqual([out.payment.notes, out.payment.paid_on], ['edited', '2026-09-30']);
  assert.deepEqual(db.ctx[db.ctx.length - 1], { actor: U, reason: 'typo in the note', edit: 'on' });
  const pend = (await pay(svc, { status: 'pending', paidOn: null, idempotencyKey: 'pending-key-3', amount: 7 })).payment;
  await svc.amendDetails({ tenantId: T, paymentId: pend.id, userId: U, patch: { notes: 'chasing' } });
  assert.equal(db.ctx[db.ctx.length - 1].edit, 'off');
});

test('the service never issues a DELETE', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services/finance/ledger.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\bDELETE\b/);
});
