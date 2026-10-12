// Ad identity against real PostgreSQL, in a throwaway schema. SKIPPED unless ADS_TEST_DATABASE_URL points at an
// ISOLATED local test database (never dev/QA/staging/prod). NOT EXECUTED in the authoring environment: it has only
// been syntax-checked, so treat the first real run as the first verification of the SQL (see the report).
//
// One scenario, in the order the rollout is meant to happen:
//   legacy schema collides loudly -> additive migrations change nothing -> explicit dual_write -> backfill (dry run,
//   apply, rerun, unresolvable reported and not guessed) -> readiness FAIL -> step-5 constraints/indexes ->
//   readiness PASS -> scoped -> legacy unique keys still reject cross-account / cross-ad-group duplicates -> rollback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const url = process.env.ADS_TEST_DATABASE_URL;
const skip = !url && 'set ADS_TEST_DATABASE_URL (isolated local curvelead_test_* database) to run';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const statements = (sql) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);

test('ad identity end to end on PostgreSQL: explicit rollout, complete backfill, legacy keys intact', { skip }, async () => {
  if (!/curvelead_test|localhost|127\.0\.0\.1/.test(url)) throw new Error('ADS_TEST_DATABASE_URL must be a local/test database');
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  const schema = 'adid_' + Date.now();
  const q = (s, p) => c.query(s, p);
  const T = '11111111-1111-1111-1111-111111111111';
  const ai = require('../services/adIdentity');
  const backfill = require('../scripts/backfillAdIdentity');
  const readiness = require('../scripts/adIdentityReadiness');
  const rollout = require('../scripts/adIdentityRollout');
  const mode = async () => { ai.resetIdentityModeCache(); return ai.getIdentityMode({ query: q }, { force: true }); };
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q(`SET timezone='UTC';
      CREATE TABLE tenants(id uuid PRIMARY KEY, name text, settings jsonb DEFAULT '{}');
      CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, role text, is_active boolean DEFAULT true);
      CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, source text, status text,
        meta_campaign_id text, meta_adset_id text, daily_budget numeric, lifetime_budget numeric, budget numeric, updated_at timestamp);
      CREATE TABLE lead_stages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, pos int, position int, is_won boolean DEFAULT false, is_lost boolean DEFAULT false);
      CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, stage text, campaign_id uuid, assigned_to uuid, google_campaign_id text, merged_into_id uuid, created_at timestamp DEFAULT now());
      CREATE TABLE lead_stage_history(tenant_id uuid, lead_id uuid, new_stage text, changed_at timestamp DEFAULT now());`);
    for (const f of ['migration_ads_phase1.sql']) await q(read(`models/${f}`));
    await q(`SET search_path TO ${schema}`);
    await q('INSERT INTO tenants(id,name) VALUES($1,$2)', [T, 'T']);

    const acct = async (provider, ext, currency) => (await q('INSERT INTO ad_accounts(tenant_id,provider,external_id,name,currency) VALUES($1,$2,$3,$4,$5) RETURNING id', [T, provider, ext, ext, currency])).rows[0].id;
    const meta1 = await acct('meta', 'act_1', 'INR'), meta2 = await acct('meta', 'act_2', 'USD'), goog = await acct('google', '1234567890', 'INR');
    const insight = (acc, type, id, adset = null) => q(`INSERT INTO ad_insights_daily(tenant_id,ad_account_id,entity_type,entity_id,date,spend,adset_external_id) VALUES($1,$2,$3,$4,'2026-10-01',1,$5)`, [T, acc, type, id, adset]);

    // 1. Legacy schema: the same Meta campaign id under two accounts cannot coexist (fails loudly).
    await insight(meta1, 'campaign', '555');
    await assert.rejects(insight(meta2, 'campaign', '555'), /duplicate key|unique/i);
    await insight(goog, 'ad', '999', '10');
    await insight(goog, 'ad', '998', null); // a Google ad insight row with no ad group id: must stay unresolvable
    const gc = (await q(`INSERT INTO ad_campaigns(tenant_id,ad_account_id,external_id,name) VALUES($1,$2,'5','C') RETURNING id`, [T, goog])).rows[0].id;
    const gs = (await q(`INSERT INTO ad_adsets(tenant_id,ad_campaign_id,external_id,name) VALUES($1,$2,'10','G') RETURNING id`, [T, gc])).rows[0].id;
    await q(`INSERT INTO ad_ads(tenant_id,ad_adset_id,external_id,name) VALUES($1,$2,'999','A')`, [T, gs]);

    // 2. Additive migrations change NO behaviour: columns exist, the app is still legacy.
    await q(read('models/migration_ad_identity_columns.sql'));
    assert.equal(await mode(), 'legacy', 'columns alone never switch the mode');
    await q(read('models/migration_ad_identity_rollout.sql'));
    assert.equal(await mode(), 'legacy', 'an empty rollout table is still legacy');
    assert.equal((await q('SELECT count(*)::int n FROM ad_identity_rollout')).rows[0].n, 0, 'the migration seeds no row');

    // 3. The backfill refuses to apply before writers are filling keys.
    await assert.rejects(backfill.run({ client: c, apply: true }), /Refusing --apply: rollout state is 'unset'/);
    await rollout.transition({ client: c, to: 'dual_write', by: 'test' });
    assert.equal(await mode(), 'dual_write');

    // 4. Backfill: dry run writes nothing; apply fills; unresolvable is reported, not guessed; reruns are no-ops.
    const dry = await backfill.run({ client: c, batch: 2 });
    assert.equal((await q('SELECT count(*)::int n FROM ad_insights_daily WHERE entity_key IS NOT NULL')).rows[0].n, 0);
    assert.equal(dry.tables.ad_insights_daily.would_fill, 2, 'the campaign row and the keyed Google ad row');
    assert.equal(dry.tables.ad_insights_daily.unresolvable, 1, 'the Google ad row with no ad group id');
    const applied = await backfill.run({ client: c, apply: true, batch: 2 });
    const rows = (await q('SELECT entity_id, entity_key, provider, currency FROM ad_insights_daily ORDER BY entity_type, entity_id')).rows;
    assert.deepEqual(rows.find((r) => r.entity_id === '999'), { entity_id: '999', entity_key: '10~999', provider: 'google', currency: 'INR' });
    assert.deepEqual(rows.find((r) => r.entity_id === '555'), { entity_id: '555', entity_key: '555', provider: 'meta', currency: 'INR' });
    assert.equal(rows.find((r) => r.entity_id === '998').entity_key, null, 'no guessed key');
    assert.equal(applied.unresolvable.by_reason['ad_insights_daily.google_ad_missing_ad_group_id'], 1);
    assert.equal((await q(`SELECT external_key FROM ad_ads WHERE external_id='999'`)).rows[0].external_key, '10~999');
    const again = await backfill.run({ client: c, apply: true, batch: 2 });
    assert.equal(again.tables.ad_insights_daily.filled, 0); assert.equal(again.tables.ad_campaigns.filled, 0);

    // 5. Readiness is a read-only FAIL while keys, structure and the unresolvable row are outstanding.
    const before = await readiness.run({ client: c });
    assert.equal(before.status, 'FAIL');
    assert.ok(before.failing.includes('unresolvable_records') && before.failing.includes('scoped_structure') && before.failing.includes('dual_write_soak'));
    assert.equal(before.checks.find((x) => x.name === 'unresolvable_records').count, 1);
    await assert.rejects(rollout.transition({ client: c, to: 'scoped' }), /readiness FAILED/);
    assert.equal(await mode(), 'dual_write');

    // 6. The owner retires the unresolvable row (a data decision the scripts never make); then step 5 runs
    //    statement by statement (CONCURRENTLY needs autocommit, which a bare client is).
    await q(`DELETE FROM ad_insights_daily WHERE entity_id = '998'`);
    for (const s of statements(read('db/phase1/ad_identity/03_constraints_and_indexes.sql'))) await q(s);
    assert.equal(await mode(), 'dual_write', 'valid indexes and constraints still do not switch the mode');
    await q(`UPDATE ad_identity_rollout SET updated_at = now() - interval '1 hour'`); // satisfy the soak (test database only)
    const ok = await readiness.run({ client: c });
    assert.equal(ok.status, 'PASS', JSON.stringify(ok.checks.filter((x) => x.status === 'FAIL')));

    // 7. Scoped, explicitly.
    await rollout.transition({ client: c, to: 'scoped', by: 'test' });
    assert.equal(await mode(), 'scoped');

    // 8. Legacy unique keys are still in force: duplicates fail loudly instead of being absorbed.
    await assert.rejects(q(`INSERT INTO ad_campaigns(tenant_id,ad_account_id,external_id,external_key,provider,name) VALUES($1,$2,'5','5','meta','dup')
       ON CONFLICT ${ai.conflictTarget('scoped', 'ad_campaigns')} DO NOTHING`, [T, meta1]), /unique/i, 'same external id under another account hits the legacy key');
    const gs2 = (await q(`INSERT INTO ad_adsets(tenant_id,ad_campaign_id,external_id,ad_account_id,external_key,provider,name) VALUES($1,$2,'11',$3,'11','google','G2') RETURNING id`, [T, gc, goog])).rows[0].id;
    await assert.rejects(q(`INSERT INTO ad_ads(tenant_id,ad_adset_id,external_id,ad_account_id,external_key,provider,name) VALUES($1,$2,'999',$3,'11~999','google','A2')`, [T, gs2, goog]),
      /unique/i, 'the same Google ad id in a second ad group is still rejected by the legacy key until the key swap');
    await assert.rejects(q(`INSERT INTO ad_ads(tenant_id,ad_adset_id,external_id,name) VALUES($1,$2,'777','nokey')`, [T, gs2]), /key_present|check constraint/i, 'a row without keys is rejected by the validated CHECK');

    // 9. Rollback is one explicit step and instant.
    await rollout.transition({ client: c, to: 'dual_write' });
    assert.equal(await mode(), 'dual_write');
    await assert.rejects(rollout.transition({ client: c, to: 'legacy' }), /refusing legacy/);
  } finally {
    ai.resetIdentityModeCache();
    await q(`SET search_path TO public; DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
});
