// Cohort metrics, health, shadow log, the advance migration and the attribution backfill against REAL PostgreSQL
// (throwaway schema in a throwaway curvelead_test_* database). Skipped unless PHASE1_TEST_DATABASE_URL is set;
// run with scripts/runPhase1SqlTests.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const url = process.env.PHASE1_TEST_DATABASE_URL;
const skip = !url && 'set PHASE1_TEST_DATABASE_URL (a throwaway curvelead_test_* database) to run';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('cohort reporting end to end on PostgreSQL', { skip }, async (t) => {
  if (!/\/curvelead_test_[a-z0-9_]+(\?.*)?$/.test(url)) throw new Error('PHASE1_TEST_DATABASE_URL must point at a database named curvelead_test_*');
  const { Client } = require('pg');
  const schema = 'p1c_' + Date.now();
  const admin = new Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const c = new Client({ connectionString: url }); await c.connect(); await c.query(`SET search_path TO ${schema}; SET timezone='UTC'`);
  const q = (s, p) => c.query(s, p);
  const T = '11111111-1111-1111-1111-111111111111', T2 = '22222222-2222-2222-2222-222222222222', T3 = '33333333-3333-3333-3333-333333333333';
  const mocks = { '../config/db': { query: q, transaction: async (fn) => { await q('BEGIN'); try { const r = await fn(c); await q('COMMIT'); return r; } catch (e) { await q('ROLLBACK'); throw e; } }, pool: {} } };
  const loaded = {}; const dbPath = require.resolve('../config/db');
  const savedDb = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mocks['../config/db'] };
  const fresh = (f) => { const p = require.resolve(f); delete require.cache[p]; loaded[p] = true; return require(p); };
  try {
    await q(`CREATE TABLE tenants(id uuid PRIMARY KEY, settings jsonb DEFAULT '{}', name text);
      CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, status text DEFAULT 'active');
      CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, stage text, deal_value numeric(12,2) DEFAULT 0, advance_received numeric(12,2) DEFAULT 0,
        won_at timestamp, updated_at timestamp DEFAULT now(), created_at timestamptz DEFAULT now(), campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
        source text, source_detail text, meta_lead_id text, meta_ad_id text, meta_adset_id text, meta_form_id text, google_lead_id text, google_campaign_id text, google_adgroup_id text,
        google_creative_id text, gclid text, merged_into_id uuid, merged_at timestamptz, is_test_lead boolean NOT NULL DEFAULT false, lead_score text, assigned_to uuid);
      CREATE TABLE lead_stages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, pos int, position int, is_won boolean DEFAULT false, is_lost boolean DEFAULT false, is_qualified boolean DEFAULT false, is_active boolean DEFAULT true);
      CREATE TABLE lead_stage_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, prev_stage text, new_stage text, changed_at timestamp DEFAULT now());
      CREATE TABLE ad_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, currency text);
      CREATE TABLE ad_campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, ad_account_id uuid, external_id text, campaign_id uuid);
      CREATE TABLE ad_insights_daily(tenant_id uuid, ad_account_id uuid, entity_type text, entity_id text, date date, spend numeric DEFAULT 0, leads int DEFAULT 0);`);
    await q(`INSERT INTO tenants(id, name, settings) VALUES ($1,'Main','{}'), ($2,'Other','{}'), ($3,'Dollar','{"currency":"USD"}')`, [T, T2, T3]);
    for (const tenant of [T, T2, T3]) for (const [n, pos, won, lost, qual] of [['New', 1, false, false, false], ['Qualified', 2, false, false, true], ['Won', 3, true, false, false], ['Lost', 4, false, true, false]]) {
      await q('INSERT INTO lead_stages(tenant_id,name,pos,is_won,is_lost,is_qualified) VALUES($1,$2,$3,$4,$5,$6)', [tenant, n, pos, won, lost, qual]);
    }
    for (const f of ['milestones', 'attribution', 'lead_payments', 'booking', 'reporting']) await q(read(`models/migration_phase1_${f}.sql`));

    const camp = async (tenant, name) => (await q('INSERT INTO campaigns(tenant_id,name) VALUES($1,$2) RETURNING id', [tenant, name])).rows[0].id;
    const C1 = await camp(T, 'Diwali offer'), C2 = await camp(T, 'Worked example'), C3 = await camp(T, 'Dollar ads'), C4 = await camp(T, 'No spend data'), C5 = await camp(T, 'No customers yet');
    const acctInr = (await q(`INSERT INTO ad_accounts(tenant_id,currency) VALUES($1,'INR') RETURNING id`, [T])).rows[0].id;
    const acctUsd = (await q(`INSERT INTO ad_accounts(tenant_id,currency) VALUES($1,'USD') RETURNING id`, [T])).rows[0].id;
    for (const [camp_, ext, acct, spend] of [[C1, 'x1', acctInr, 10000], [C2, 'x2', acctInr, 10000], [C3, 'x3', acctUsd, 100], [C5, 'x5', acctInr, 500]]) {
      await q('INSERT INTO ad_campaigns(tenant_id, ad_account_id, external_id, campaign_id) VALUES($1,$2,$3,$4)', [T, acct, ext, camp_]);
      await q(`INSERT INTO ad_insights_daily(tenant_id, ad_account_id, entity_type, entity_id, date, spend) VALUES($1,$2,'campaign',$3,'2026-10-10',$4)`, [T, acct, ext, spend]);
    }

    // direct: insert the lead already in `stage` (an import / API), instead of creating it New and moving it.
    const lead = async ({ tenant = T, campaign = null, stage = 'New', price = 0, created = '2026-10-05 12:00+00', test = false, cols = {}, direct = false } = {}) => {
      const keys = Object.keys(cols);
      const id = (await q(`INSERT INTO leads(tenant_id, stage, campaign_id, created_at, is_test_lead${keys.map((k) => `, ${k}`).join('')}) VALUES($1,$5,$2,$3,$4${keys.map((_, i) => `, $${i + 6}`).join('')}) RETURNING id`,
        [tenant, campaign, created, test, direct ? stage : 'New', ...keys.map((k) => cols[k])])).rows[0].id;
      if (!direct && (stage !== 'New' || price)) await q('UPDATE leads SET stage = $2, deal_value = $3 WHERE id = $1', [id, stage, price]);
      return id;
    };
    let n = 0;
    const pay = (leadId, amount, over = {}) => q(`INSERT INTO lead_payments(tenant_id, lead_id, kind, status, amount, currency, paid_on, paid_on_basis, parent_id, reason, idempotency_key)
      VALUES($1,$2,$3,'completed',$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [over.tenant || T, leadId, over.kind || 'payment', amount, over.currency || 'INR', over.paid_on === undefined ? '2026-10-12' : over.paid_on, over.basis || 'confirmed', over.parent || null, over.reason || null, `k${++n}`]).then((r) => r.rows[0].id);

    // ---- the data ---------------------------------------------------------------------------------------------------------------------------
    const L1 = await lead({ campaign: C1, stage: 'Won', price: 20000, cols: { source: 'meta_ads', meta_lead_id: 'ml1' } });
    const p1 = await pay(L1, 5000); await pay(L1, 10000); await pay(L1, 2000, { kind: 'refund', parent: p1, reason: 'part refund' });
    const L2 = await lead({ campaign: C1, stage: 'Qualified' }); await pay(L2, 3000, { basis: 'unknown', paid_on: null });
    await lead({ campaign: C1 });
    const L4 = await lead({ campaign: C1, stage: 'Won', price: 8000 }); await q(`UPDATE leads SET stage = 'Lost' WHERE id = $1`, [L4]);
    const S = await lead({ campaign: C1 });
    const A = await lead({ campaign: C1, stage: 'Won', price: 700 }); await pay(A, 700);
    await q('UPDATE leads SET merged_into_id = $2 WHERE id = $1', [A, S]);
    await lead({ campaign: C1, stage: 'Won', price: 99999, test: true });
    await lead({ campaign: C1, stage: 'Won', price: 1234, created: '2026-09-15 12:00+00' });
    const W = await lead({ campaign: C2, stage: 'Won', price: 20000 });
    const w1 = await pay(W, 5000); await pay(W, 10000); await pay(W, 2000, { kind: 'refund', parent: w1, reason: 'part refund' });
    const X = await lead({ campaign: C3, stage: 'Won', price: 1000 }); await pay(X, 1000);
    const N = await lead({ campaign: C4, stage: 'Won', price: 3000 }); await pay(N, 3000);
    await lead({ campaign: C5 }); await lead({ campaign: C5 });
    const U = await lead({ stage: 'Won', price: 5000 }); await pay(U, 5000);
    const other = await camp(T2, 'Other tenant'); await lead({ tenant: T2, campaign: other, stage: 'Won', price: 7777 });

    const cohort = fresh('../services/cohortMetrics');
    const req = (from, to) => ({ tenantId: T, user: { role: 'admin' }, query: { period: 'custom', date_from: from, date_to: to } });
    const { cohort: r, scope } = await cohort.getCohortMetrics(req('2026-10-01', '2026-10-31'));
    const row = (id) => r.campaigns.find((x) => x.campaign_id === id);
    const amt = (list, cur = 'INR') => (list.find((x) => x.currency === cur) || {}).amount;
    const v = (x, k) => x.ratios[k].value;

    await t.test('campaign with several leads: counts, merged customer counted once, test and out-of-range leads excluded', async () => {
      const a = row(C1);
      assert.deepEqual([a.leads, a.qualified, a.acquired, a.cancelled], [5, 4, 3, 1], 'L1 L2 L3 L4 and the survivor S; A is merged, the test lead and the September lead are out');
      assert.equal(a.campaign_name, 'Diwali offer');
    });

    await t.test('booked revenue is the frozen snapshot; collected is NET, split into Won / not-yet-Won lines and by date basis', async () => {
      const a = row(C1);
      assert.equal(amt(a.booked), 28000, 'L1 20,000 + L4 8,000 (the survivor inherits nothing in plain SQL)');
      assert.equal(amt(a.collected.net), 16700, '13,000 (L1 after refund) + 3,000 (L2) + 700 (absorbed lead, counted at its root)');
      assert.equal(amt(a.collected.on_won_leads), 13700); assert.equal(amt(a.collected.on_non_won_leads), 3000);
      assert.equal(amt(a.collected.by_date_basis.unknown), 3000, 'the undated payment is disclosed on its own line');
      assert.equal(amt(a.collected.by_date_basis.confirmed), 13700);
    });

    await t.test('ratios for that campaign', async () => {
      const a = row(C1);
      assert.deepEqual([v(a, 'cpl'), v(a, 'cost_per_qualified'), v(a, 'cac'), v(a, 'booked_roas'), v(a, 'collected_roas'), v(a, 'advertising_roi_pct')], [2000, 2500, 3333.33, 2.8, 1.67, 67]);
    });

    await t.test('the worked example comes out exactly: booked ROAS 2.00, collected ROAS 1.30, ROI 30.0%', async () => {
      const w = row(C2);
      assert.deepEqual([w.leads, w.acquired, amt(w.booked), amt(w.collected.net)], [1, 1, 20000, 13000]);
      assert.deepEqual([v(w, 'booked_roas'), v(w, 'collected_roas'), v(w, 'advertising_roi_pct'), v(w, 'cac')], [2, 1.3, 30, 10000]);
    });

    await t.test('spend in USD against revenue in INR: every revenue ratio is null (currency_mismatch), the unit cost is still given', async () => {
      const x = row(C3);
      for (const k of ['booked_roas', 'collected_roas', 'advertising_roi_pct']) assert.deepEqual(x.ratios[k], { value: null, reason: 'currency_mismatch' }, k);
      assert.equal(v(x, 'cpl'), 100); assert.equal(x.spend.currency, 'USD');
    });

    await t.test('a campaign with no spend rows is "not measured", never zero; a campaign with spend but no customers has a real 0 and a null CAC', async () => {
      const no = row(C4);
      assert.equal(no.spend.measured, false);
      for (const k of Object.keys(no.ratios)) assert.equal(no.ratios[k].reason, 'not_measured', k);
      const five = row(C5);
      assert.deepEqual([five.leads, five.acquired, v(five, 'cpl'), five.ratios.cac.reason, v(five, 'collected_roas')], [2, 0, 250, 'no_customers', 0]);
    });

    await t.test('unattributed leads have their own row without spend; totals only compute ratios over campaigns with spend data and never mix currencies', async () => {
      const u = r.unattributed_row;
      assert.deepEqual([u.leads, u.acquired, amt(u.booked), amt(u.collected.net), u.spend.reason], [1, 1, 5000, 5000, 'not_applicable_unattributed']);
      assert.deepEqual([r.totals.leads, r.totals.acquired], [11, 7], 'C1 3 + C2 1 + C3 1 + C4 1 + unattributed 1');
      assert.equal(amt(r.totals.collected.net), 38700);
      assert.equal(r.totals.ratios.cpl.reason, 'mixed_spend_currencies', 'INR and USD spend are never added');
      assert.equal(r.totals.ratios_scope, 'campaigns_with_spend_data');
    });

    await t.test('quality block: attribution coverage and the cohort-maturity note travel with the numbers', async () => {
      assert.equal(r.quality.attribution.unattributed, 1); assert.equal(r.quality.attribution.coverage_pct, 90.91);
      assert.ok(r.quality.maturity.note); assert.equal(r.model, 'cohort');
      assert.equal(r.quality.milestones.won_stage_without_event, 0);
    });

    await t.test('other workspaces never leak in', async () => {
      assert.ok(!r.campaigns.some((x) => x.campaign_id === other));
      assert.notEqual(amt(r.totals.booked), 28000 + 7777);
      const t2 = (await cohort.getCohortMetrics({ ...req('2026-10-01', '2026-10-31'), tenantId: T2 })).cohort;
      assert.deepEqual([t2.totals.leads, t2.totals.acquired], [1, 1]);
    });

    await t.test('a campaign filter narrows every figure', async () => {
      const only = (await cohort.getCohortMetrics(req('2026-10-01', '2026-10-31'), { campaignIds: [C2] })).cohort;
      assert.deepEqual([only.totals.leads, only.campaigns.length], [1, 1]);
    });

    await t.test('an audited attribution correction moves a lead to the corrected campaign; the original stays', async () => {
      const a = await lead({ campaign: C4, created: '2026-11-05 12:00+00' }); const b = await lead({ campaign: C4, created: '2026-11-06 12:00+00' });
      const attribution = fresh('../services/attribution');
      await attribution.correct({ tenantId: T, leadId: b, userId: null, crmCampaignId: C5, reason: 'It came from the other campaign' });
      const nov = (await cohort.getCohortMetrics(req('2026-11-01', '2026-11-30'))).cohort;
      assert.equal(nov.campaigns.find((x) => x.campaign_id === C4).leads, 1);
      assert.equal(nov.campaigns.find((x) => x.campaign_id === C5).leads, 1);
      const g = await attribution.getAttribution({ tenantId: T, leadId: b });
      assert.deepEqual([g.original.crm_campaign_id, g.effective.crm_campaign_id, g.status], [C4, C5, 'manual']);
      assert.deepEqual(g.events.map((e) => e.event), ['captured', 'corrected']);
      assert.equal((await q('SELECT campaign_id FROM leads WHERE id = $1', [b])).rows[0].campaign_id, C5, 'the legacy field stays in step');
      await assert.rejects(attribution.correct({ tenantId: T, leadId: a, userId: null, crmCampaignId: C5, reason: '' }), /reason/i);
    });

    await t.test('a booking adjustment changes booked revenue in the cohort; the snapshot is kept', async () => {
      const booking = fresh('../services/finance/booking');
      await booking.adjust({ tenantId: T, leadId: W, userId: null, value: 18000, reason: 'Agreed discount', evidenceRef: 'INV-7' });
      const again = (await cohort.getCohortMetrics(req('2026-10-01', '2026-10-31'))).cohort;
      const w = again.campaigns.find((x) => x.campaign_id === C2);
      assert.equal(amt(w.booked), 18000); assert.equal(v(w, 'booked_roas'), 1.8);
      assert.equal(w.booked_detail[0].adjusted, 1);
      assert.equal(Number((await q('SELECT booked_value FROM leads WHERE id = $1', [W])).rows[0].booked_value), 20000);
    });

    await t.test('health: flags what must be fixed before the numbers are trusted', async () => {
      await lead({ stage: 'Won', direct: true }); // created directly in Won: suppressed, so no counted Won event
      const oldWay = await lead({ campaign: C5 }); await q('UPDATE leads SET advance_received = 500 WHERE id = $1', [oldWay]); // an advance typed the old way, nothing in the ledger
      const h = await cohort.getHealth(T);
      const by = Object.fromEntries(h.checks.map((x) => [x.id, x]));
      assert.equal(by.won_without_event.ok, false); assert.ok(by.won_without_event.count >= 1);
      assert.equal(by.advances_not_migrated.ok, false); assert.equal(by.advances_not_migrated.count, 1);
      assert.equal(by.entry_stage_flagged.ok, true); assert.equal(by.won_stage_exists.ok, true);
      assert.equal(by.ad_account_currencies.ok, false, 'INR and USD accounts');
      assert.equal(h.ok, true, 'only warnings: no error-level check failed');
    });

    await t.test('shadow mode records the difference from the legacy figures', async () => {
      const shadow = await cohort.recordShadow(scope, r);
      assert.deepEqual(shadow.map((s) => s.metric), ['leads', 'customers', 'qualified']);
      for (const s of shadow) assert.equal(s.delta, s.cohort - s.legacy);
      const logged = (await q(`SELECT metric, legacy, cohort, delta FROM metric_shadow_log WHERE tenant_id = $1 ORDER BY metric`, [T])).rows;
      assert.equal(logged.length, 3);
    });

    await t.test('advance migration: dry run writes nothing; apply copies each advance as an unknown-date payment; a rerun adds nothing', async () => {
      const adv = require('../scripts/migrateAdvancePayments');
      const W3 = await lead({ tenant: T3, stage: 'Won', price: 9000, cols: { advance_received: 5000, won_at: '2026-09-01 10:00' } });
      const N3 = await lead({ tenant: T3, cols: { advance_received: 1000 } });
      const Z3 = await lead({ tenant: T3, stage: 'Won', price: 400, cols: { advance_received: 300 } }); await pay(Z3, 300, { tenant: T3, currency: 'USD' });
      const AB = await lead({ tenant: T3, stage: 'Won', cols: { advance_received: 700 } }); await q('UPDATE leads SET merged_into_id = $2 WHERE id = $1', [AB, W3]);
      const before = (await q('SELECT count(*)::int n FROM lead_payments WHERE tenant_id = $1', [T3])).rows[0].n;
      const dry = await adv.run({ client: c, tenantId: T3, batch: 2 });
      assert.deepEqual([dry.would_migrate, dry.migrated, dry.skipped_has_ledger_rows, dry.not_won_anomalies, dry.currency], [2, 0, 1, 1, 'USD']);
      assert.deepEqual([dry.absorbed_review.leads, dry.absorbed_review.total_amount], [1, 700]);
      assert.equal((await q('SELECT count(*)::int n FROM lead_payments WHERE tenant_id = $1', [T3])).rows[0].n, before, 'a dry run writes nothing');
      const done = await adv.run({ client: c, tenantId: T3, apply: true, batch: 1 });
      assert.deepEqual([done.migrated, done.total_amount], [2, 6000]);
      const rows = (await q(`SELECT lead_id, amount, currency, status, paid_on, paid_on_basis, to_char(estimated_paid_on,'YYYY-MM-DD') AS est, source, method FROM lead_payments WHERE tenant_id = $1 AND source = 'migration' ORDER BY amount DESC`, [T3])).rows;
      assert.deepEqual(rows.map((x) => [Number(x.amount), x.currency, x.status, x.paid_on, x.paid_on_basis, x.est, x.source, x.method]),
        [[5000, 'USD', 'completed', null, 'unknown', '2026-09-01', 'migration', 'migrated_advance'], [1000, 'USD', 'completed', null, 'unknown', null, 'migration', 'migrated_advance']]);
      assert.equal((await q('SELECT count(*)::int n FROM lead_payments WHERE lead_id = $1', [AB])).rows[0].n, 0, 'the absorbed lead was not migrated');
      const again = await adv.run({ client: c, tenantId: T3, apply: true });
      assert.equal(again.migrated, 0); assert.equal((await q('SELECT count(*)::int n FROM lead_payments WHERE tenant_id = $1', [T3])).rows[0].n, before + 2);
      const net = (await q('SELECT net FROM v_lead_net_collected WHERE lead_id = $1', [W3])).rows[0];
      assert.equal(Number(net.net), 5000);
      const hh = await cohort.getHealth(T3);
      assert.equal(hh.checks.find((x) => x.id === 'advances_not_migrated').ok, true, 'the health report agrees');
    });

    await t.test('attribution backfill: dry run counts by status, apply needs a workspace, creates labelled records once, skips merged leads', async () => {
      const back = require('../scripts/backfillAttribution');
      await q('ALTER TABLE leads DISABLE TRIGGER lead_attribution_capture');
      const c0 = await camp(T3, 'Old campaign');
      const v1 = await lead({ tenant: T3, campaign: c0, cols: { source: 'meta_ads', meta_lead_id: 'old-1' } });
      const i1 = await lead({ tenant: T3, campaign: c0 });
      const u1 = await lead({ tenant: T3 });
      const m1 = await lead({ tenant: T3 }); await q('UPDATE leads SET merged_into_id = $2 WHERE id = $1', [m1, u1]);
      await q('ALTER TABLE leads ENABLE TRIGGER lead_attribution_capture');
      const missing = async () => (await q(`SELECT count(*)::int n FROM leads l WHERE tenant_id = $1 AND merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM lead_attribution a WHERE a.lead_id = l.id)`, [T3])).rows[0].n;
      const before = await missing(); assert.ok(before >= 3);
      const dry = await back.run({ client: c, tenantId: T3, batch: 2 });
      assert.equal(dry.created, 0); assert.ok(dry.by_status.verified >= 1 && dry.by_status.inferred >= 1 && dry.by_status.unattributed >= 1);
      await assert.rejects(back.run({ client: c, apply: true }), /without --tenant/);
      const done = await back.run({ client: c, tenantId: T3, apply: true, batch: 2 });
      assert.equal(done.created, before); assert.equal(await missing(), 0);
      const rec = Object.fromEntries((await q(`SELECT lead_id, status, capture_basis, original_crm_campaign_id FROM lead_attribution WHERE lead_id = ANY($1)`, [[v1, i1, u1]])).rows.map((x) => [x.lead_id, x]));
      assert.deepEqual([rec[v1].status, rec[i1].status, rec[u1].status], ['verified', 'inferred', 'unattributed']);
      assert.ok(Object.values(rec).every((x) => x.capture_basis === 'backfill'));
      assert.equal(rec[v1].original_crm_campaign_id, c0);
      assert.equal((await q('SELECT count(*)::int n FROM lead_attribution WHERE lead_id = $1', [m1])).rows[0].n, 0, 'merged leads are skipped');
      assert.equal((await q(`SELECT count(*)::int n FROM lead_attribution_events WHERE lead_id = $1 AND event = 'captured'`, [v1])).rows[0].n, 1);
      assert.equal((await back.run({ client: c, tenantId: T3, apply: true })).created, 0, 'a rerun creates nothing');
    });

    await t.test('the milestone backfill books existing Won leads from their price, labelled as inferred', async () => {
      await q('ALTER TABLE leads DISABLE TRIGGER lead_milestones_trigger');
      const old = await lead({ stage: 'Won', price: 4200, created: '2026-08-01 10:00+00' });
      await q('ALTER TABLE leads ENABLE TRIGGER lead_milestones_trigger');
      assert.equal((await q('SELECT booked_at FROM leads WHERE id = $1', [old])).rows[0].booked_at, null);
      await require('../scripts/backfillMilestones').run({ client: c, apply: true, batch: 50 });
      const b = (await q('SELECT booked_value, booked_basis FROM leads WHERE id = $1', [old])).rows[0];
      assert.deepEqual([Number(b.booked_value), b.booked_basis], [4200, 'inferred_from_deal_value']);
    });
  } finally {
    for (const p of Object.keys(loaded)) delete require.cache[p];
    for (const p of [require.resolve('../services/metrics'), require.resolve('../services/adIdentity'), require.resolve('../services/attribution'), require.resolve('../services/finance/booking')]) delete require.cache[p];
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    await c.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
