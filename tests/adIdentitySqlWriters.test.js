// The REAL writers and readers (Google/Meta hierarchy + daily metrics, Ads Manager lists) against real PostgreSQL, in
// whichever identity mode the database is currently in. Run it once per mode, moving the database with the rollout
// script between runs (legacy -> dual_write -> scoped); every expectation below is keyed on the mode it detects.
// Needs the full app schema like the sibling SQL tests: skipped unless BATCH1_TEST_DATABASE_URL points at an ISOLATED
// test database (schema.sql + models/migration_*.sql applied). Creates and removes its own workspace.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.BATCH1_TEST_DATABASE_URL;
let db = null;
if (url) {
  if (!/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('BATCH1_TEST_DATABASE_URL must be a local database');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });
  db = { pool, query: (t, p) => pool.query(t, p),
    transaction: async (fn) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } } };
  const p = require.resolve('../config/db');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: db };
}
const skip = !url && 'set BATCH1_TEST_DATABASE_URL to run';
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const warnings = async (fn) => { const w = []; const o = console.warn; console.warn = (...a) => w.push(a.join(' ')); try { await fn(); } finally { console.warn = o; } return w; };

test('real writers and readers behave correctly in the current identity mode', { skip }, async () => {
  const ai = require('../services/adIdentity');
  ai.resetIdentityModeCache();
  const mode = await ai.getIdentityMode(db, { force: true });
  console.log(`      [identity mode under test: ${mode}]`);
  const t = crypto.randomUUID();
  await db.query(`INSERT INTO tenants (id, name, slug, email, settings) VALUES ($1,'W',$2,$3,'{}')`, [t, `w-${t.slice(0, 8)}`, `w-${t.slice(0, 8)}@example.test`]);
  try {
    const acct = async (provider, ext, currency) => (await db.query(`INSERT INTO ad_accounts (tenant_id, provider, external_id, name, currency) VALUES ($1,$2,$3,$3,$4) RETURNING id`, [t, provider, ext, currency])).rows[0].id;
    const g = await acct('google', '1234567890', 'INR'), m = await acct('meta', 'act_77', 'INR');
    const google = require('../services/googleAds/sync');
    const metaH = require('../services/metaAds/hierarchy');
    const metaI = require('../services/metaAds/insights');
    const keyed = mode !== 'legacy';
    // Before the additive migration the new columns do not exist at all: only the writers/readers are exercised then.
    const hasCols = (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ad_ads' AND column_name = 'external_key'`)).rows.length > 0;
    if (keyed) assert.ok(hasCols, 'a keyed mode requires the columns');

    // ---- Google hierarchy: two ad groups, one ad each, DIFFERENT ad ids -----------------------------------------
    await google.saveHierarchy({ tenantId: t, adAccountId: g,
      campaigns: [{ external_id: '5', name: 'C', effective_status: 'ACTIVE', objective: 'SEARCH' }],
      adGroups: [{ external_id: '10', campaign_external_id: '5', name: 'G10' }, { external_id: '11', campaign_external_id: '5', name: 'G11' }],
      ads: [{ external_id: '901', adset_external_id: '10', name: 'a', creative: {} }, { external_id: '902', adset_external_id: '11', name: 'b', creative: {} }] });
    const ads = (await db.query(`SELECT external_id, ${hasCols ? 'external_key, provider, ad_account_id' : 'NULL::text AS external_key, NULL::text AS provider, NULL::uuid AS ad_account_id'} FROM ad_ads WHERE tenant_id = $1 ORDER BY external_id`, [t])).rows;
    assert.equal(ads.length, 2);
    if (keyed) assert.deepEqual(ads.map((r) => [r.external_key, r.provider, r.ad_account_id]), [['10~901', 'google', g], ['11~902', 'google', g]]);
    else assert.ok(ads.every((r) => r.external_key === null && r.provider === null), 'legacy mode leaves the new columns untouched');
    const sets = hasCols ? (await db.query(`SELECT external_id, ad_account_id, external_key FROM ad_adsets WHERE tenant_id = $1 ORDER BY external_id`, [t])).rows : [];
    if (keyed) assert.deepEqual(sets.map((r) => [r.external_key, r.ad_account_id]), [['10', g], ['11', g]]);

    // ---- a re-sync is an update, not a duplicate, in every mode ---------------------------------------------------
    await google.saveHierarchy({ tenantId: t, adAccountId: g, campaigns: [{ external_id: '5', name: 'C2', effective_status: 'ACTIVE', objective: 'SEARCH' }],
      adGroups: [{ external_id: '10', campaign_external_id: '5', name: 'G10b' }],
      ads: [{ external_id: '901', adset_external_id: '10', name: 'a2', creative: {} }] });
    assert.equal((await db.query(`SELECT count(*)::int n FROM ad_ads WHERE tenant_id = $1`, [t])).rows[0].n, 2);
    assert.equal((await db.query(`SELECT name FROM ad_ads WHERE tenant_id = $1 AND external_id = '901'`, [t])).rows[0].name, 'a2');

    // ---- the same Google ad id in a second ad group: the LEGACY unique key still governs until the key swap --------
    const dupAd = () => google.saveHierarchy({ tenantId: t, adAccountId: g, campaigns: [{ external_id: '5', name: 'C', effective_status: 'ACTIVE', objective: 'SEARCH' }],
      adGroups: [{ external_id: '11', campaign_external_id: '5', name: 'G11' }], ads: [{ external_id: '901', adset_external_id: '11', name: 'dup', creative: {} }] });
    if (mode === 'scoped') {
      await assert.rejects(dupAd(), (e) => e.code === '23505', 'scoped mode surfaces the legacy violation loudly instead of bypassing it');
      assert.equal((await db.query(`SELECT count(*)::int n FROM ad_ads WHERE tenant_id = $1 AND external_id = '901'`, [t])).rows[0].n, 1, 'the failed sync rolled back');
    } else {
      await dupAd(); // legacy upsert: the ad is re-pointed to the other ad group (the pre-existing overwrite behaviour)
      const row = (await db.query(`SELECT s.external_id AS grp, ${hasCols ? 'a.external_key' : 'NULL::text AS external_key'} FROM ad_ads a JOIN ad_adsets s ON s.id = a.ad_adset_id WHERE a.tenant_id = $1 AND a.external_id = '901'`, [t])).rows[0];
      assert.equal(row.grp, '11');
      if (keyed) assert.equal(row.external_key, '11~901', 'dual_write keeps the key in step with the re-pointed row');
      // restore for the metrics below
      await google.saveHierarchy({ tenantId: t, adAccountId: g, campaigns: [{ external_id: '5', name: 'C', effective_status: 'ACTIVE', objective: 'SEARCH' }],
        adGroups: [{ external_id: '10', campaign_external_id: '5', name: 'G10' }], ads: [{ external_id: '901', adset_external_id: '10', name: 'a', creative: {} }] });
    }

    // ---- Google daily metrics, including a row whose ad group id is missing ------------------------------------------
    const day = '2026-10-01';
    const row = (entity_id, over = {}) => ({ entity_id, date: day, spend: 10, impressions: 100, clicks: 5, ctr: 5, cpc: 2, leads: 1, cpl: 10, actions: null, campaign_external_id: '5', adset_external_id: null, ...over });
    const w = await warnings(() => google.saveDailyMetrics({ tenantId: t, adAccountId: g, externalAccountId: '1234567890', since: day, until: day,
      rows: { campaign: [row('5')], adset: [row('10', { adset_external_id: '10' })], ad: [row('901', { adset_external_id: '10' }), row('777', { adset_external_id: null })] } }));
    const gi = (await db.query(`SELECT entity_type, entity_id, ${hasCols ? 'entity_key, provider' : 'NULL::text AS entity_key, NULL::text AS provider'} FROM ad_insights_daily WHERE tenant_id = $1 AND ad_account_id = $2 ORDER BY entity_type, entity_id`, [t, g])).rows;
    const adRows = gi.filter((r) => r.entity_type === 'ad');
    if (keyed) {
      assert.deepEqual(adRows.map((r) => [r.entity_id, r.entity_key, r.provider]), [['901', '10~901', 'google']], 'the ad-group-less row is not stored');
      assert.ok(w.some((x) => /1 row\(s\) had no ad group id/.test(x)), 'and it is reported, not silent');
      assert.ok(gi.every((r) => r.entity_key && r.provider === 'google'), 'every stored row carries its key, including the account roll-up');
    } else {
      assert.deepEqual(adRows.map((r) => r.entity_id), ['777', '901'], 'legacy mode stores both, as before');
      assert.ok(gi.every((r) => r.entity_key === null));
    }

    // ---- Meta hierarchy + insights ---------------------------------------------------------------------------------
    await metaH.saveHierarchy({ tenantId: t, adAccountId: m, campaigns: [{ id: '8001', name: 'MC', status: 'ACTIVE', effective_status: 'ACTIVE', adsets: [{ id: '8002', name: 'MS', ads: [{ id: '8003', name: 'MA' }] }] }] });
    await metaI.saveDailyInsights({ tenantId: t, adAccountId: m, externalAccountId: 'act_77', since: day, until: day,
      rows: [{ ad_id: '8003', adset_id: '8002', campaign_id: '8001', date_start: day, spend: '20', impressions: '200', clicks: '10', actions: [] }] });
    const mi = (await db.query(`SELECT entity_type, entity_id, ${hasCols ? 'entity_key, provider' : 'NULL::text AS entity_key, NULL::text AS provider'} FROM ad_insights_daily WHERE tenant_id = $1 AND ad_account_id = $2 ORDER BY entity_type`, [t, m])).rows;
    assert.deepEqual(mi.map((r) => r.entity_type), ['account', 'ad', 'adset', 'campaign']);
    if (keyed) assert.ok(mi.every((r) => r.entity_key === r.entity_id && r.provider === 'meta'));
    else assert.ok(mi.every((r) => r.entity_key === null));
    const mc = (await db.query(`SELECT ${hasCols ? 'external_key, provider' : 'NULL::text AS external_key, NULL::text AS provider'} FROM ad_campaigns WHERE tenant_id = $1 AND external_id = '8001'`, [t])).rows[0];
    assert.deepEqual(mc, keyed ? { external_key: '8001', provider: 'meta' } : { external_key: null, provider: null });

    // ---- readers return the same totals in every mode --------------------------------------------------------------------
    const ctrl = require('../controllers/adsController');
    const call = async (fn, req) => { const r = res(); await fn({ tenantId: t, user: { id: crypto.randomUUID(), role: 'admin' }, query: {}, params: {}, ...req }, r); assert.equal(r.code, 200, JSON.stringify(r.data)); return r.data; };
    const range = { from: day, to: day };
    const camps = await call(ctrl.listCampaigns, { query: { ...range, account_id: g } });
    assert.equal(camps.campaigns[0].spend, 10);
    const gSet = (await db.query(`SELECT id FROM ad_campaigns WHERE tenant_id = $1 AND external_id = '5'`, [t])).rows[0].id;
    const setsList = await call(ctrl.listAdsets, { params: { id: gSet }, query: range });
    assert.equal(setsList.adsets.find((s) => s.external_id === '10').spend, 10);
    const set10 = (await db.query(`SELECT id FROM ad_adsets WHERE tenant_id = $1 AND external_id = '10'`, [t])).rows[0].id;
    const adsList = await call(ctrl.listAds, { params: { id: set10 }, query: range });
    assert.equal(adsList.ads.length, 1); assert.equal(adsList.ads[0].spend, 10, 'the ad is joined to its own insights');
    assert.equal(adsList.ads[0].entity_key, mode === 'scoped' ? '10~901' : undefined);
    const daily = await call(ctrl.dailyInsights, { query: { entity_type: 'ad', entity_id: '10~901', ...range } });
    assert.equal(daily.days.length, 1); assert.equal(daily.days[0].spend, 10);
    const mDaily = await call(ctrl.dailyInsights, { query: { entity_type: 'ad', entity_id: '8003', ...range } });
    assert.equal(mDaily.days[0].spend, 20);
  } finally {
    await db.query('DELETE FROM campaigns WHERE tenant_id = $1', [t]).catch(() => {});
    await db.query('DELETE FROM tenants WHERE id = $1', [t]);
    await db.pool.end();
  }
});
