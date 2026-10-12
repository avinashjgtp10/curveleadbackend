// Revenue timeline against REAL PostgreSQL (throwaway schema in a throwaway curvelead_test_* database). Skipped unless
// PHASE1_TEST_DATABASE_URL is set; run with scripts/runPhase1SqlTests.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const url = process.env.PHASE1_TEST_DATABASE_URL;
const skip = !url && 'set PHASE1_TEST_DATABASE_URL (a throwaway curvelead_test_* database) to run';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('revenue timeline: booked and collected per bucket, per currency, undated kept apart', { skip }, async () => {
  if (!/\/curvelead_test_[a-z0-9_]+(\?.*)?$/.test(url)) throw new Error('PHASE1_TEST_DATABASE_URL must point at a database named curvelead_test_*');
  const { Client } = require('pg');
  const schema = 'p1t_' + Date.now();
  const admin = new Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const c = new Client({ connectionString: url }); await c.connect(); await c.query(`SET search_path TO ${schema}; SET timezone='UTC'`);
  const q = (s, p) => c.query(s, p);
  const T = '11111111-1111-1111-1111-111111111111', T2 = '22222222-2222-2222-2222-222222222222';
  const dbPath = require.resolve('../config/db'); const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: q, transaction: async (fn) => fn(c), pool: {} } };
  try {
    await q(`CREATE TABLE tenants(id uuid PRIMARY KEY, settings jsonb DEFAULT '{}', name text);
      CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text);
      CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, stage text, deal_value numeric(12,2) DEFAULT 0, advance_received numeric(12,2) DEFAULT 0,
        won_at timestamp, updated_at timestamp DEFAULT now(), created_at timestamptz DEFAULT now(), campaign_id uuid, source text, source_detail text, meta_lead_id text, meta_ad_id text,
        meta_adset_id text, meta_form_id text, google_lead_id text, google_campaign_id text, google_adgroup_id text, google_creative_id text, gclid text, merged_into_id uuid, merged_at timestamptz,
        is_test_lead boolean NOT NULL DEFAULT false, lead_score text, assigned_to uuid);
      CREATE TABLE lead_stages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, pos int, position int, is_won boolean DEFAULT false, is_lost boolean DEFAULT false, is_qualified boolean DEFAULT false, is_active boolean DEFAULT true);
      CREATE TABLE lead_stage_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, prev_stage text, new_stage text, changed_at timestamp DEFAULT now());`);
    await q(`INSERT INTO tenants(id, name, settings) VALUES ($1,'Main','{}'), ($2,'Other','{}')`, [T, T2]);
    for (const tenant of [T, T2]) for (const [n, pos, won] of [['New', 1, false], ['Won', 2, true]]) await q('INSERT INTO lead_stages(tenant_id,name,pos,is_won) VALUES($1,$2,$3,$4)', [tenant, n, pos, won]);
    for (const f of ['milestones', 'attribution', 'lead_payments', 'booking']) await q(read(`models/migration_phase1_${f}.sql`));
    const { getTimeline, bucketFor } = (() => { const p = require.resolve('../services/revenueTimeline'); delete require.cache[p]; delete require.cache[require.resolve('../services/metrics')]; return require(p); })();

    // two weeks of October 2026 (UTC-based IST default tz does not matter: all instants are mid-day)
    const won = async (tenant, price, wonAt, over = {}) => {
      const id = (await q(`INSERT INTO leads(tenant_id, stage, is_test_lead) VALUES($1,'New',$2) RETURNING id`, [tenant, !!over.test])).rows[0].id;
      await q(`UPDATE leads SET stage='Won', deal_value=$2 WHERE id=$1`, [id, price]);
      await q(`UPDATE leads SET booked_at = $2 WHERE id = $1`, [id, wonAt]); // the snapshot trigger set it to now(); pin it for a deterministic test
      return id;
    };
    let k = 0;
    const pay = (tenant, lead, amount, over = {}) => q(`INSERT INTO lead_payments(tenant_id, lead_id, kind, status, amount, currency, paid_on, paid_on_basis, estimated_paid_on, parent_id, reason, idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [tenant, lead, over.kind || 'payment', over.status || 'completed', amount, over.currency || 'INR',
      over.paid_on === undefined ? null : over.paid_on, over.basis || (over.paid_on === null ? 'unknown' : 'confirmed'), over.est || null, over.parent || null, over.reason || null, `k${++k}`]);

    const A = await won(T, 20000, '2026-10-06 10:00+00'), B = await won(T, 5000, '2026-10-14 10:00+00'), D = await won(T, 700, '2026-10-07 10:00+00', { test: true });
    await won(T2, 99999, '2026-10-07 10:00+00');
    const pA = (await pay(T, A, 8000, { paid_on: '2026-10-06' })).rows[0].id;
    await pay(T, A, 2000, { paid_on: '2026-10-14' });
    await pay(T, A, 1000, { kind: 'refund', paid_on: '2026-10-15', parent: pA, reason: 'part refund' });
    await pay(T, B, 500, { paid_on: null, est: '2026-10-08', basis: 'estimated' });
    await pay(T, B, 4000, { paid_on: null });                       // completed, no date at all -> undated
    await pay(T, B, 9999, { status: 'pending', paid_on: null });    // pending is never collected, never undated
    await pay(T, D, 700, { paid_on: '2026-10-06' });                // test lead
    await pay(T, A, 50, { currency: 'USD', paid_on: '2026-10-07' }); // other currency stays separate
    await pay(T2, (await q('SELECT id FROM leads WHERE tenant_id=$1', [T2])).rows[0].id, 123, { paid_on: '2026-10-06' });

    const req = (query) => ({ tenantId: T, user: { role: 'admin' }, query });
    assert.equal(bucketFor(new Date('2026-10-01'), new Date('2026-10-31')), 'week');
    assert.equal(bucketFor(new Date('2026-01-01'), new Date('2026-10-31')), 'month');

    const tl = await getTimeline(req({ period: 'custom', date_from: '2026-10-01', date_to: '2026-10-31' }));
    assert.equal(tl.bucket, 'week');
    const byBucket = Object.fromEntries(tl.series.map((s) => [s.bucket, s]));
    // ISO weeks start Monday: 5 Oct, 12 Oct
    assert.deepEqual(byBucket['2026-10-05'].booked, { INR: 20000 });                 // A booked 6 Oct; test lead and other tenant excluded
    assert.deepEqual(byBucket['2026-10-12'].booked, { INR: 5000 });                  // B booked 14 Oct
    assert.deepEqual(byBucket['2026-10-05'].collected, { INR: 8500, USD: 50 });      // 8000 + estimated 500 (8 Oct); USD separate
    assert.deepEqual(byBucket['2026-10-12'].collected, { INR: 1000 });               // 2000 paid - 1000 refund
    assert.deepEqual(tl.undated, [{ currency: 'INR', amount: 4000, entries: 1 }], 'completed undated money is reported once; pending never appears');
    assert.equal(tl.series.length, 2);

    const none = await getTimeline(req({ period: 'custom', date_from: '2025-01-01', date_to: '2025-01-31' }));
    assert.deepEqual(none.series, []);
    const wide = await getTimeline(req({ period: 'custom', date_from: '2026-01-01', date_to: '2026-10-31' }));
    assert.equal(wide.bucket, 'month'); assert.deepEqual(wide.series.map((s) => s.bucket), ['2026-10-01']);
    assert.deepEqual(wide.series[0].collected, { INR: 9500, USD: 50 });
    assert.deepEqual(wide.series[0].booked, { INR: 25000 });
  } finally {
    require.cache[dbPath] = saved; if (!saved) delete require.cache[dbPath];
    await c.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});

test('the timeline route is gated like cohort metrics', () => {
  assert.match(read('routes/cohort.js'), /router\.get\('\/timeline', requirePermission\('finance\.view'\), ctrl\.revenueTimeline\)/);
  const ctl = read('controllers/cohortController.js');
  assert.match(ctl, /revenueTimeline = async[\s\S]*?mode === 'off'[\s\S]*?feature_off[\s\S]*?mode === 'shadow' && !isAdmin/);
});
