// The payment ledger against REAL PostgreSQL, in a throwaway schema of a throwaway curvelead_test_* database.
// Skipped unless PHASE1_TEST_DATABASE_URL is set; run it with scripts/runPhase1SqlTests.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const url = process.env.PHASE1_TEST_DATABASE_URL;
const skip = !url && 'set PHASE1_TEST_DATABASE_URL (a throwaway curvelead_test_* database) to run';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('payment ledger: money rules enforced by the database', { skip }, async (t) => {
  if (!/\/curvelead_test_[a-z0-9_]+(\?.*)?$/.test(url)) throw new Error('PHASE1_TEST_DATABASE_URL must point at a database named curvelead_test_*');
  const { Client } = require('pg');
  const schema = 'p1l_' + Date.now();
  const connect = async () => { const c = new Client({ connectionString: url }); await c.connect(); await c.query(`SET search_path TO ${schema}; SET timezone='UTC'`); return c; };
  const admin = new Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const c = await connect();
  const extra = [];
  const T = '11111111-1111-1111-1111-111111111111', T2 = '22222222-2222-2222-2222-222222222222';
  let n = 0;
  const pay = (client, o = {}) => client.query(
    `INSERT INTO lead_payments (tenant_id, lead_id, kind, status, amount, currency, adjustment_direction, parent_id, paid_on, paid_on_basis, method, reference, notes, reason, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [o.tenant ?? T, o.lead, o.kind ?? 'payment', o.status ?? 'completed', o.amount, o.currency ?? 'INR', o.dir ?? null, o.parent ?? null,
      o.paid_on === undefined ? '2026-10-01' : o.paid_on, o.basis ?? 'confirmed', o.method ?? null, o.reference ?? null, o.notes ?? null, o.reason ?? null, o.key ?? `k${++n}`]).then((r) => r.rows[0]);
  const refund = (client, parent, amount, o = {}) => pay(client, { kind: 'refund', lead: parent.lead_id, parent: parent.id, amount, reason: 'customer request', ...o });
  const lead = async (tenant = T) => (await c.query('INSERT INTO leads(tenant_id) VALUES($1) RETURNING id', [tenant])).rows[0].id;
  const net = async (leadId, currency = 'INR') => { const r = (await c.query('SELECT * FROM v_lead_net_collected WHERE lead_id = $1 AND currency = $2', [leadId, currency])).rows[0]; return r ? { net: Number(r.net), gross: Number(r.gross_paid), pending: Number(r.pending), payments: r.payments } : null; };
  try {
    await c.query(`CREATE TABLE tenants(id uuid PRIMARY KEY);
      CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, merged_into_id uuid, merged_at timestamptz, created_at timestamptz DEFAULT now());`);
    await c.query('INSERT INTO tenants(id) VALUES ($1), ($2)', [T, T2]);
    await c.query(read('models/migration_phase1_lead_payments.sql'));
    await c.query(read('models/migration_phase1_lead_payments.sql')); // idempotent: runs twice

    await t.test('the worked example: Rs 20,000 deal, payments 5,000 + 10,000, refund 2,000 -> net 13,000', async () => {
      const L = await lead(); const other = await lead();
      const first = await pay(c, { lead: L, amount: 5000 });
      await pay(c, { lead: L, amount: 10000 });
      await refund(c, first, 2000);
      assert.deepEqual(await net(L), { net: 13000, gross: 15000, pending: 0, payments: 2 });
      await pay(c, { lead: other, amount: 3000 });
      assert.equal((await net(other)).net, 3000, 'a payment on another lead is its own line');
    });

    await t.test('pending, failed and cancelled entries never count; pending is reported on its own', async () => {
      const L = await lead();
      await pay(c, { lead: L, amount: 1000 });
      await pay(c, { lead: L, amount: 999, status: 'pending', paid_on: null });
      await pay(c, { lead: L, amount: 500, status: 'failed' });
      assert.deepEqual(await net(L), { net: 1000, gross: 1000, pending: 999, payments: 1 });
    });

    await t.test('adjustments add (credit) or subtract (debit); both need a reason', async () => {
      const L = await lead();
      await pay(c, { lead: L, amount: 1000 });
      await pay(c, { lead: L, kind: 'adjustment', dir: 'credit', amount: 200, reason: 'bank charge waived' });
      await pay(c, { lead: L, kind: 'adjustment', dir: 'debit', amount: 50, reason: 'rounding' });
      assert.equal((await net(L)).net, 1150);
      await assert.rejects(pay(c, { lead: L, kind: 'adjustment', dir: 'credit', amount: 5 }), /check constraint/i, 'reason is mandatory');
      await assert.rejects(pay(c, { lead: L, kind: 'adjustment', amount: 5, reason: 'x' }), /check constraint/i, 'direction is mandatory');
    });

    await t.test('refunds: over the remaining amount, in another currency, on a pending / foreign / refund parent are all rejected', async () => {
      const L = await lead(); const M = await lead();
      const p = await pay(c, { lead: L, amount: 1000 });
      await refund(c, p, 400);
      await assert.rejects(refund(c, p, 700), /OVER_REFUND/);
      await refund(c, p, 600); // exactly what is left
      await assert.rejects(refund(c, p, 1), /OVER_REFUND/);
      const p2 = await pay(c, { lead: L, amount: 100 });
      await assert.rejects(refund(c, p2, 50, { currency: 'USD' }), /CURRENCY_MISMATCH/);
      const pending = await pay(c, { lead: L, amount: 100, status: 'pending', paid_on: null });
      await assert.rejects(refund(c, pending, 10), /PARENT_NOT_COMPLETED/);
      await assert.rejects(pay(c, { kind: 'refund', lead: M, parent: p2.id, amount: 10, reason: 'x' }), /PARENT_NOT_FOUND/, 'a payment of another lead');
      const r = (await c.query(`SELECT id FROM lead_payments WHERE parent_id = $1 LIMIT 1`, [p.id])).rows[0];
      await assert.rejects(pay(c, { kind: 'refund', lead: L, parent: r.id, amount: 1, reason: 'x' }), /PARENT_NOT_COMPLETED/, 'a refund of a refund');
      await assert.rejects(pay(c, { kind: 'refund', lead: L, amount: 1, reason: 'x' }), /check constraint/i, 'a refund needs a parent');
      await assert.rejects(pay(c, { kind: 'refund', lead: L, parent: p2.id, amount: 1 }), /check constraint/i, 'a refund needs a reason');
    });

    await t.test('a reversal covers the full remaining amount and only one per payment is possible', async () => {
      const L = await lead();
      const p = await pay(c, { lead: L, amount: 1000 });
      await refund(c, p, 300);
      await assert.rejects(pay(c, { kind: 'reversal', lead: L, parent: p.id, amount: 1000, reason: 'bounced' }), /OVER_REFUND/);
      await assert.rejects(pay(c, { kind: 'reversal', lead: L, parent: p.id, amount: 400, reason: 'bounced' }), /REVERSAL_AMOUNT/);
      await pay(c, { kind: 'reversal', lead: L, parent: p.id, amount: 700, reason: 'bounced' });
      assert.equal((await net(L)).net, 0);
      await assert.rejects(pay(c, { kind: 'reversal', lead: L, parent: p.id, amount: 700, reason: 'again' }), /OVER_REFUND|duplicate key/);
    });

    await t.test('a wrong amount is fixed by a reversal plus a new payment: both stay visible, net is right', async () => {
      const L = await lead();
      const wrong = await pay(c, { lead: L, amount: 5000 });
      await pay(c, { kind: 'reversal', lead: L, parent: wrong.id, amount: 5000, reason: 'entered 5000 instead of 500' });
      await c.query(`INSERT INTO lead_payments (tenant_id, lead_id, kind, amount, currency, paid_on, idempotency_key, replaces_id) VALUES ($1,$2,'payment',500,'INR','2026-10-01','fix-1',$3)`, [T, L, wrong.id]);
      assert.equal((await net(L)).net, 500);
      assert.equal((await c.query('SELECT count(*)::int n FROM lead_payments WHERE lead_id = $1', [L])).rows[0].n, 3);
    });

    await t.test('concurrent refunds can never exceed the payment (10 clients x 30 against 100 -> exactly 3 succeed)', async () => {
      const L = await lead(); const p = await pay(c, { lead: L, amount: 100 });
      const clients = await Promise.all(Array.from({ length: 10 }, connect)); extra.push(...clients);
      const results = await Promise.allSettled(clients.map((cl) => refund(cl, p, 30)));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
      assert.ok(results.filter((r) => r.status === 'rejected').every((r) => /OVER_REFUND/.test(r.reason.message)));
      assert.equal((await net(L)).net, 10);
    });

    await t.test('a refund racing a reversal: exactly one wins', async () => {
      const L = await lead(); const p = await pay(c, { lead: L, amount: 100 });
      const [a, b] = await Promise.all([connect(), connect()]); extra.push(a, b);
      const results = await Promise.allSettled([refund(a, p, 40), pay(b, { kind: 'reversal', lead: L, parent: p.id, amount: 100, reason: 'chargeback' })]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const total = Number((await c.query(`SELECT COALESCE(sum(amount),0) s FROM lead_payments WHERE parent_id = $1`, [p.id])).rows[0].s);
      assert.ok(total === 40 || total === 100);
    });

    await t.test('duplicates: the same idempotency key, and the same method + reference, are caught', async () => {
      const L = await lead();
      const first = await pay(c, { lead: L, amount: 700, key: 'idem-1', method: 'UPI', reference: 'TXN-1' });
      await assert.rejects(pay(c, { lead: L, amount: 700, key: 'idem-1' }), (e) => e.code === '23505');
      const retry = await c.query(`INSERT INTO lead_payments (tenant_id, lead_id, kind, amount, currency, paid_on, idempotency_key) VALUES ($1,$2,'payment',700,'INR','2026-10-01','idem-1') ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`, [T, L]);
      assert.equal(retry.rows.length, 0, 'a retry inserts nothing, so the service can return the original');
      await assert.rejects(pay(c, { lead: L, amount: 700, method: ' upi ', reference: 'txn-1' }), (e) => e.code === '23505', 'case and spacing do not matter');
      await assert.rejects(c.query(`UPDATE lead_payments SET status = 'cancelled' WHERE id = $1`, [first.id]), /STATUS_FINAL/, 'a completed payment cannot be voided to free its reference');
      const pend = await pay(c, { lead: L, amount: 50, status: 'pending', paid_on: null, method: 'UPI', reference: 'TXN-2' });
      await c.query(`UPDATE lead_payments SET status = 'cancelled' WHERE id = $1`, [pend.id]);
      await pay(c, { lead: L, amount: 50, method: 'UPI', reference: 'TXN-2' }); // the cancelled one freed the reference
    });

    await t.test('rows are never deleted, and a lead with payments cannot be deleted', async () => {
      const L = await lead(); const p = await pay(c, { lead: L, amount: 10 });
      await assert.rejects(c.query('DELETE FROM lead_payments WHERE id = $1', [p.id]), /never deleted/);
      await assert.rejects(c.query('DELETE FROM leads WHERE id = $1', [L]), /foreign key/i);
      assert.equal((await c.query('SELECT count(*)::int n FROM lead_payments WHERE id = $1', [p.id])).rows[0].n, 1);
    });

    await t.test('amount, currency, kind, lead and links never change; only a pending entry can change status', async () => {
      const L = await lead(); const M = await lead();
      const p = await pay(c, { lead: L, amount: 100 });
      for (const set of ['amount = 1', `currency = 'USD'`, `kind = 'adjustment'`, `lead_id = '${M}'`, `tenant_id = '${T2}'`, `idempotency_key = 'zzz'`, `reason = 'x'`, `created_at = now() - interval '1 day'`]) {
        await assert.rejects(c.query(`UPDATE lead_payments SET ${set} WHERE id = $1`, [p.id]), /IMMUTABLE|check constraint|violates/i, set);
      }
      await assert.rejects(c.query(`UPDATE lead_payments SET status = 'cancelled' WHERE id = $1`, [p.id]), /STATUS_FINAL/, 'a completed payment is reversed, never voided');
      const pend = await pay(c, { lead: L, amount: 20, status: 'pending', paid_on: null });
      await assert.rejects(c.query(`UPDATE lead_payments SET status = 'completed' WHERE id = $1`, [pend.id]), /check constraint/i, 'a confirmed payment needs its date to complete');
      await c.query(`UPDATE lead_payments SET status = 'completed', paid_on = '2026-10-02' WHERE id = $1`, [pend.id]);
      assert.equal((await net(L)).net, 120, 'completing a pending entry (with its date) makes it count');
      await assert.rejects(c.query(`UPDATE lead_payments SET status = 'failed' WHERE id = $1`, [pend.id]), /STATUS_FINAL/);
    });

    await t.test('payment details change only inside an audited correction, and the database writes before/after itself', async () => {
      const L = await lead(); const p = await pay(c, { lead: L, amount: 100, notes: 'first', method: 'cash' });
      await assert.rejects(c.query(`UPDATE lead_payments SET notes = 'edited' WHERE id = $1`, [p.id]), /AUDITED_ONLY/);
      const actor = '33333333-3333-3333-3333-333333333333';
      await c.query('BEGIN');
      await c.query(`SELECT set_config('curvelead.payment_edit', 'on', true), set_config('curvelead.actor', $1, true), set_config('curvelead.reason', 'typo in note', true)`, [actor]);
      await c.query(`UPDATE lead_payments SET notes = 'edited', paid_on = '2026-09-30' WHERE id = $1`, [p.id]);
      await c.query('COMMIT');
      const a = (await c.query(`SELECT action, before, after, reason, actor FROM financial_audit_log WHERE entity_id = $1 ORDER BY created_at, id`, [p.id])).rows;
      assert.deepEqual(a.map((x) => x.action), ['created', 'details_corrected']);
      assert.equal(a[1].before.notes, 'first'); assert.equal(a[1].after.notes, 'edited'); assert.equal(a[1].after.paid_on, '2026-09-30');
      assert.equal(a[1].reason, 'typo in note'); assert.equal(a[1].actor, actor);
      await assert.rejects(c.query(`UPDATE lead_payments SET notes = 'again' WHERE id = $1`, [p.id]), /AUDITED_ONLY/, 'the flag does not leak past the transaction');
    });

    await t.test('a status change is audited, and the audit log itself is append-only', async () => {
      const L = await lead(); const pend = await pay(c, { lead: L, amount: 40, status: 'pending', paid_on: null });
      await c.query(`UPDATE lead_payments SET status = 'failed' WHERE id = $1`, [pend.id]);
      const a = (await c.query(`SELECT action FROM financial_audit_log WHERE entity_id = $1 ORDER BY created_at, id`, [pend.id])).rows.map((x) => x.action);
      assert.deepEqual(a, ['created', 'status_failed']);
      await assert.rejects(c.query(`UPDATE financial_audit_log SET action = 'x' WHERE entity_id = $1`, [pend.id]), /append-only/);
      await assert.rejects(c.query(`DELETE FROM financial_audit_log WHERE entity_id = $1`, [pend.id]), /append-only/);
    });

    await t.test('table checks: positive amount, 3-letter upper-case currency, a confirmed payment needs a date', async () => {
      const L = await lead();
      for (const o of [{ amount: 0 }, { amount: -5 }, { amount: 5, currency: 'inr' }, { amount: 5, currency: 'RUPEES' }, { amount: 5, paid_on: null }, { amount: 5, key: '  ' }]) {
        await assert.rejects(pay(c, { lead: L, ...o }), /check constraint/i, JSON.stringify(o));
      }
      await pay(c, { lead: L, amount: 5, paid_on: null, basis: 'unknown' }); // migrated advances: unknown date is allowed
    });

    await t.test('tenant isolation: a payment cannot be written for another workspace\'s lead', async () => {
      const L = await lead(T);
      await assert.rejects(pay(c, { tenant: T2, lead: L, amount: 10 }), /LEAD_NOT_FOUND/);
      await assert.rejects(pay(c, { lead: '99999999-9999-9999-9999-999999999999', amount: 10 }), /LEAD_NOT_FOUND|foreign key/i);
    });

    await t.test('merges: money stays on its original lead, a merged lead takes no new payments, reports resolve to the root', async () => {
      const A = await lead(); const B = await lead();
      await pay(c, { lead: A, amount: 1000 }); await pay(c, { lead: B, amount: 400 }); await pay(c, { lead: B, amount: 100, currency: 'USD' });
      await c.query('UPDATE leads SET merged_into_id = $2, merged_at = now() WHERE id = $1', [B, A]);
      await assert.rejects(pay(c, { lead: B, amount: 1 }), /LEAD_MERGED/);
      assert.equal((await net(B)).net, 400, 'B keeps its own payment rows');
      const root = (await c.query('SELECT currency, net FROM v_person_net_collected WHERE root_lead_id = $1 ORDER BY currency', [A])).rows.map((r) => [r.currency, Number(r.net)]);
      assert.deepEqual(root, [['INR', 1400], ['USD', 100]], 'per currency, never added together');
      assert.equal((await c.query('SELECT count(*)::int n FROM v_person_net_collected WHERE root_lead_id = $1', [B])).rows[0].n, 0);
    });

    await t.test('merged leads always point at a root: no merge into a merged lead, and re-merging flattens', async () => {
      const X = await lead(); const Y = await lead(); const Z = await lead();
      await c.query('UPDATE leads SET merged_into_id = $2 WHERE id = $1', [Y, X]);
      await assert.rejects(c.query('UPDATE leads SET merged_into_id = $2 WHERE id = $1', [Z, Y]), /itself merged/);
      await assert.rejects(c.query('UPDATE leads SET merged_into_id = id WHERE id = $1', [Z]), /itself/);
      await c.query('UPDATE leads SET merged_into_id = $2 WHERE id = $1', [X, Z]); // X (which Y points at) is merged into Z
      assert.equal((await c.query('SELECT merged_into_id FROM leads WHERE id = $1', [Y])).rows[0].merged_into_id, Z, 'Y now points straight at the root');
    });

    await t.test('a merge and a payment serialize: a payment that waits on the merge is rejected once the lead is merged', async () => {
      const A = await lead(); const B = await lead();
      const mergeConn = await connect(); const payConn = await connect(); extra.push(mergeConn, payConn);
      await mergeConn.query('BEGIN');
      await mergeConn.query('SELECT id FROM leads WHERE id = $1 FOR UPDATE', [B]);
      const waiting = pay(payConn, { lead: B, amount: 5 }).then(() => 'inserted', (e) => e.message);
      await new Promise((r) => setTimeout(r, 300));
      await mergeConn.query('UPDATE leads SET merged_into_id = $2 WHERE id = $1', [B, A]);
      await mergeConn.query('COMMIT');
      assert.match(await waiting, /LEAD_MERGED/);
    });

    await t.test('the migration touches no existing data and runs twice without change', async () => {
      assert.ok((await c.query('SELECT count(*)::int n FROM leads')).rows[0].n > 10);
      assert.equal((await c.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('lead_payments_guard_trigger','lead_payments_audit_trigger','leads_root_chain_guard_trigger','leads_root_chain_flatten_trigger','financial_audit_log_immutable') AND NOT tgisinternal`)).rows[0].n, 5);
    });
  } finally {
    for (const e of extra) await e.end().catch(() => {});
    await c.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
