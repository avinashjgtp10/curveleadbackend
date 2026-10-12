// Booked value against REAL PostgreSQL (throwaway schema in a throwaway curvelead_test_* database).
// Skipped unless PHASE1_TEST_DATABASE_URL is set; run with scripts/runPhase1SqlTests.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const url = process.env.PHASE1_TEST_DATABASE_URL;
const skip = !url && 'set PHASE1_TEST_DATABASE_URL (a throwaway curvelead_test_* database) to run';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('booked value: frozen at the first Won, quote edits never change it, adjustments are audited', { skip }, async (t) => {
  if (!/\/curvelead_test_[a-z0-9_]+(\?.*)?$/.test(url)) throw new Error('PHASE1_TEST_DATABASE_URL must point at a database named curvelead_test_*');
  const { Client } = require('pg');
  const schema = 'p1b_' + Date.now();
  const admin = new Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const c = new Client({ connectionString: url }); await c.connect(); await c.query(`SET search_path TO ${schema}; SET timezone='UTC'`);
  const T = '11111111-1111-1111-1111-111111111111', T_USD = '22222222-2222-2222-2222-222222222222';
  try {
    await c.query(`CREATE TABLE tenants(id uuid PRIMARY KEY, settings jsonb DEFAULT '{}');
      CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, stage text, deal_value numeric(12,2) DEFAULT 0, won_at timestamp, updated_at timestamp DEFAULT now(), merged_into_id uuid);
      CREATE TABLE lead_stages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, pos int, is_won boolean DEFAULT false, is_lost boolean DEFAULT false, is_qualified boolean DEFAULT false, is_active boolean DEFAULT true);`);
    await c.query(`INSERT INTO tenants(id, settings) VALUES ($1, '{}'), ($2, '{"currency":"USD"}')`, [T, T_USD]);
    for (const tenant of [T, T_USD]) for (const [n, pos, won, lost] of [['New', 1, false, false], ['Won', 2, true, false], ['Lost', 3, false, true]]) {
      await c.query('INSERT INTO lead_stages(tenant_id,name,pos,is_won,is_lost) VALUES($1,$2,$3,$4,$5)', [tenant, n, pos, won, lost]);
    }
    await c.query(read('models/migration_phase1_milestones.sql'));
    await c.query(read('models/migration_phase1_booking.sql'));
    await c.query(read('models/migration_phase1_booking.sql')); // idempotent
    const lead = async (tenant = T, stage = 'New', price = 0) => (await c.query('INSERT INTO leads(tenant_id, stage, deal_value) VALUES($1,$2,$3) RETURNING id', [tenant, stage, price])).rows[0].id;
    const booked = async (id) => { const r = (await c.query('SELECT booked_value, booked_currency, booked_basis, booked_source, booked_at FROM leads WHERE id = $1', [id])).rows[0]; return { ...r, booked_value: r.booked_value == null ? null : Number(r.booked_value) }; };

    await t.test('marking a lead Won with a price freezes that price as the booking, in the workspace currency', async () => {
      const L = await lead();
      await c.query(`UPDATE leads SET stage = 'Won', deal_value = 20000 WHERE id = $1`, [L]);
      const b = await booked(L);
      assert.deepEqual([b.booked_value, b.booked_currency, b.booked_basis, b.booked_source], [20000, 'INR', 'live_snapshot', 'won_event']);
      assert.ok(b.booked_at);
      const usd = await lead(T_USD); await c.query(`UPDATE leads SET stage = 'Won', deal_value = 500 WHERE id = $1`, [usd]);
      assert.equal((await booked(usd)).booked_currency, 'USD', 'the currency is the workspace\'s');
    });

    await t.test('editing the quote afterwards, or moving through other won stages, never changes the booking', async () => {
      const L = await lead(); await c.query(`UPDATE leads SET stage = 'Won', deal_value = 20000 WHERE id = $1`, [L]);
      await c.query(`UPDATE leads SET deal_value = 99999 WHERE id = $1`, [L]);
      await c.query(`UPDATE leads SET stage = 'Lost' WHERE id = $1`, [L]); await c.query(`UPDATE leads SET stage = 'Won', deal_value = 1 WHERE id = $1`, [L]);
      assert.equal((await booked(L)).booked_value, 20000);
    });

    await t.test('Won before a price exists: the first price entered afterwards becomes the booking, once', async () => {
      const L = await lead(); await c.query(`UPDATE leads SET stage = 'Won' WHERE id = $1`, [L]);
      assert.equal((await booked(L)).booked_value, null, 'nothing to freeze yet');
      await c.query(`UPDATE leads SET deal_value = 15000 WHERE id = $1`, [L]);
      const b = await booked(L); assert.deepEqual([b.booked_value, b.booked_basis, b.booked_source], [15000, 'live_snapshot_late', 'price_entered_after_won']);
      await c.query(`UPDATE leads SET deal_value = 16000 WHERE id = $1`, [L]);
      assert.equal((await booked(L)).booked_value, 15000, 'later edits do not rewrite it');
    });

    await t.test('a price on a lead that never reached Won books nothing', async () => {
      const L = await lead(); await c.query(`UPDATE leads SET deal_value = 7000 WHERE id = $1`, [L]);
      assert.equal((await booked(L)).booked_value, null);
    });

    await t.test('a lead created directly in Won (suppressed milestone) is not booked until it really reaches Won', async () => {
      const L = await lead(T, 'Won', 3000);
      assert.equal((await booked(L)).booked_value, null);
      await c.query(`UPDATE leads SET stage = 'Lost' WHERE id = $1`, [L]); await c.query(`UPDATE leads SET stage = 'Won' WHERE id = $1`, [L]);
      assert.equal((await booked(L)).booked_value, 3000);
    });

    await t.test('a backfilled Won event books with the inferred basis', async () => {
      const L = await lead(T, 'Won', 4000);
      await c.query(`INSERT INTO lead_milestone_events(tenant_id, lead_id, milestone, occurred_at, source) VALUES ($1,$2,'won','2026-03-01 10:00','backfill')`, [T, L]);
      const b = await booked(L); assert.deepEqual([b.booked_value, b.booked_basis], [4000, 'inferred_from_deal_value']);
      assert.equal((await c.query(`SELECT to_char(booked_at,'YYYY-MM-DD HH24:MI') AS at FROM leads WHERE id = $1`, [L])).rows[0].at, '2026-03-01 10:00', 'dated from the event');
    });

    await t.test('an adjustment needs a reason, is append-only, and the latest one is the effective booked value', async () => {
      const L = await lead(); await c.query(`UPDATE leads SET stage = 'Won', deal_value = 20000 WHERE id = $1`, [L]);
      const eff = async () => (await c.query('SELECT value, currency, booked_basis, adjusted FROM v_lead_booked WHERE lead_id = $1', [L])).rows[0];
      let e = await eff(); assert.deepEqual([Number(e.value), e.currency, e.adjusted], [20000, 'INR', false]);
      await assert.rejects(c.query(`INSERT INTO booking_adjustments(tenant_id, lead_id, previous_value, new_value, reason) VALUES ($1,$2,20000,18000,'  ')`, [T, L]), /check constraint/i);
      await assert.rejects(c.query(`INSERT INTO booking_adjustments(tenant_id, lead_id, previous_value, new_value, reason) VALUES ($1,$2,20000,-1,'x')`, [T, L]), /check constraint/i);
      await c.query(`INSERT INTO booking_adjustments(tenant_id, lead_id, previous_value, new_value, reason, evidence_ref) VALUES ($1,$2,20000,18000,'agreed discount','INV-7')`, [T, L]);
      e = await eff(); assert.deepEqual([Number(e.value), e.adjusted], [18000, true]);
      await new Promise((r) => setTimeout(r, 20));
      await c.query(`INSERT INTO booking_adjustments(tenant_id, lead_id, previous_value, new_value, new_currency, reason) VALUES ($1,$2,18000,17000,'USD','currency fix')`, [T, L]);
      e = await eff(); assert.deepEqual([Number(e.value), e.currency], [17000, 'USD']);
      assert.equal((await booked(L)).booked_value, 20000, 'the original snapshot is kept');
      await assert.rejects(c.query(`UPDATE booking_adjustments SET reason = 'x' WHERE lead_id = $1`, [L]), /append-only/);
      await assert.rejects(c.query(`DELETE FROM booking_adjustments WHERE lead_id = $1`, [L]), /append-only/);
    });

    await t.test('the migration touches no existing lead and runs twice without change', async () => {
      const n = (await c.query('SELECT count(*)::int n FROM leads')).rows[0].n;
      await c.query(read('models/migration_phase1_booking.sql'));
      assert.equal((await c.query('SELECT count(*)::int n FROM leads')).rows[0].n, n);
    });
  } finally {
    await c.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
