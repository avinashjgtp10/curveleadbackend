// Phase 7a against real PostgreSQL: a Google Ads sync (fake API responses) fills the
// shared ad tables, creates and links the CRM campaign (including lead-form leads that
// arrived first), and the Ads dashboard / campaign metrics read it like Meta data.
// Skipped unless BATCH1_TEST_DATABASE_URL is set (see tests/batch1Sql.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.BATCH1_TEST_DATABASE_URL;
let db = null;
if (url) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase7-test-secret';
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });
  db = { pool, query: (t, p) => pool.query(t, p),
    transaction: async (fn) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } } };
  const p = require.resolve('../config/db');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: db };
}
const skip = !url && 'set BATCH1_TEST_DATABASE_URL to run';
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const TZ = 'Asia/Kolkata';
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

// What Google would return for customer 1234567890.
const fakeGoogle = (days) => async ({ gaql }) => {
  if (/segments.date/.test(gaql)) return daily(gaql, days);
  if (/FROM campaign WHERE campaign.status/.test(gaql)) return [
    { campaign: { id: '9001', name: 'Search – Hair Spa Pune', status: 'ENABLED', servingStatus: 'SERVING', advertisingChannelType: 'SEARCH' }, campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/31', amountMicros: '800000000', period: 'DAILY' } },
    { campaign: { id: '9002', name: 'PMax – Bridal', status: 'PAUSED', servingStatus: 'SERVING', advertisingChannelType: 'PERFORMANCE_MAX' }, campaignBudget: { amountMicros: '500000000', period: 'DAILY' } },
  ];
  if (/FROM ad_group WHERE/.test(gaql)) return [{ adGroup: { id: '55', name: 'Hair spa', status: 'ENABLED', type: 'SEARCH_STANDARD' }, campaign: { id: '9001' } }];
  if (/FROM ad_group_ad WHERE ad_group_ad.status/.test(gaql)) return [{ adGroup: { id: '55' }, adGroupAd: { status: 'ENABLED', ad: { id: '777', type: 'RESPONSIVE_SEARCH_AD', responsiveSearchAd: { headlines: [{ text: 'Hair Spa in Pune' }], descriptions: [{ text: 'Book now' }] } } } }];
  if (/FROM campaign$/.test(gaql.trim())) return [{ campaign: { id: '9001' }, metrics: { costMicros: '25000000000', impressions: '90000', clicks: '3000' } }];
  return [];
};
const daily = (gaql, days) => {
  {
    const level = /FROM ad_group_ad/.test(gaql) ? 'ad' : /FROM ad_group /.test(gaql) ? 'group' : 'campaign';
    return days.flatMap(date => {
      const m = (cost, conv) => ({ costMicros: String(cost * 1e6), impressions: '1000', clicks: '50', conversions: conv });
      if (level === 'campaign') return [{ campaign: { id: '9001' }, segments: { date }, metrics: m(400, 2) }, { campaign: { id: '9002' }, segments: { date }, metrics: m(100, 1) }];
      if (level === 'group') return [{ campaign: { id: '9001' }, adGroup: { id: '55' }, segments: { date }, metrics: m(400, 2) }];
      return [{ campaign: { id: '9001' }, adGroup: { id: '55' }, adGroupAd: { ad: { id: '777' } }, segments: { date }, metrics: m(400, 2) }];
    });
  }
};

test('a Google Ads sync fills the ad tables, links CRM campaigns and leads, and the dashboard reads it', { skip }, async () => {
  const t = crypto.randomUUID(), admin = crypto.randomUUID();
  await db.query(`INSERT INTO tenants (id, name, slug, email, settings) VALUES ($1,'G',$2,$3,$4)`, [t, `g-${t.slice(0, 8)}`, `g-${t.slice(0, 8)}@example.test`, JSON.stringify({ timezone: TZ })]);
  try {
    await db.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_active) VALUES ($1,$2,'Admin',$3,'x','admin',true)`, [admin, t, `a-${t.slice(0, 8)}@example.test`]);
    for (const [name, pos, won] of [['New', 1, false], ['Won', 2, true]]) await db.query('INSERT INTO lead_stages (tenant_id, name, pos, is_won, is_active) VALUES ($1,$2,$3,$4,true)', [t, name, pos, won]);
    const { saveGoogleToken } = require('../services/googleAds/accounts');
    const tokenId = await saveGoogleToken({ tenantId: t, userId: admin, externalUserId: 'g-sub', refreshToken: 'REFRESH', scopes: ['https://www.googleapis.com/auth/adwords'] });
    const acct = (await db.query(`INSERT INTO ad_accounts (tenant_id, provider, external_id, name, currency, timezone_name, token_id, is_primary) VALUES ($1,'google','1234567890','Glow Google','INR',$2,$3,true) RETURNING id`, [t, TZ, tokenId])).rows[0].id;
    // A lead-form lead that came in before the first sync (only google_campaign_id known).
    const early = (await db.query(`INSERT INTO leads (tenant_id, name, phone, source, stage, google_campaign_id, created_at) VALUES ($1,'Early','+919800000001','google_ads','New','9001', now() - interval '2 days') RETURNING id`, [t])).rows[0].id;

    const today = new Date();
    const days = [1, 2, 3].map(n => ymd(new Date(today - n * 864e5)));
    let tokenAsked = null;
    const { syncGoogleAccount } = require('../services/googleAds/sync');
    const deps = { search: fakeGoogle(days), accessToken: async (rt) => { tokenAsked = rt; return 'ACCESS'; } };
    const r1 = await syncGoogleAccount({ tenantId: t, adAccountId: acct }, deps);
    await syncGoogleAccount({ tenantId: t, adAccountId: acct }, deps);   // a second run changes nothing
    assert.equal(tokenAsked, 'REFRESH', 'the stored refresh token is decrypted and used');
    assert.equal(r1.campaigns, 2);

    const crm = (await db.query('SELECT id, name, source, status, actual_spend, daily_budget FROM campaigns WHERE tenant_id = $1 AND google_campaign_id = $2', [t, '9001'])).rows;
    assert.equal(crm.length, 1, 'one CRM campaign per Google campaign, even after two syncs');
    assert.deepEqual([crm[0].name, crm[0].source, crm[0].status, Number(crm[0].actual_spend), Number(crm[0].daily_budget)], ['Search – Hair Spa Pune', 'google_ads', 'active', 25000, 800]);
    assert.equal((await db.query('SELECT campaign_id FROM leads WHERE id = $1', [early])).rows[0].campaign_id, crm[0].id, 'the early lead is now attributed');

    const counts = (await db.query(`SELECT entity_type, count(*)::int n, sum(spend)::float spend, sum(leads)::int leads FROM ad_insights_daily WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, [t])).rows;
    const by = Object.fromEntries(counts.map(c => [c.entity_type, c]));
    assert.deepEqual([by.account.spend, by.account.leads], [1500, 9], 'account = all campaigns incl. Performance Max (3 days × ₹500, 3 conversions)');
    assert.deepEqual([by.campaign.n, by.adset.n, by.ad.n], [6, 3, 3]);
    assert.deepEqual((await db.query('SELECT creative->>\'title\' t FROM ad_ads WHERE tenant_id = $1', [t])).rows[0].t, 'Hair Spa in Pune');

    // The same Ads screens, with ?provider=google.
    const ads = require('../controllers/adsController');
    const req = (q) => ({ tenantId: t, user: { id: admin, role: 'admin' }, query: q, params: {}, body: {} });
    const accounts = res(); await ads.listAccounts(req({ provider: 'google' }), accounts);
    assert.deepEqual(accounts.data.accounts.map(a => a.name), ['Glow Google']);
    const meta = res(); await ads.listAccounts(req({}), meta);
    assert.equal(meta.data.accounts.length, 0, 'Meta tab doesn’t show Google accounts');
    const dash = res(); await ads.dashboard(req({ provider: 'google', from: days[2], to: days[0] }), dash);
    assert.equal(dash.code, 200, JSON.stringify(dash.data));
    assert.equal(dash.data.totals.spend, 1500);
    assert.equal(dash.data.currency, 'INR');
    const search = dash.data.campaigns.find(c => c.name.startsWith('Search'));
    assert.deepEqual([search.spend, search.meta_leads, search.crm_leads], [1200, 6, 1], 'platform conversions vs leads in CurveLead');
    assert.equal(search.cost_per_lead, 1200);

    // Shared CRM metrics pick up Google spend too.
    const { metricScope, getBreakdown } = require('../services/metrics');
    const scope = await metricScope(req({ period: 'custom', date_from: days[2], date_to: days[0] }));
    const row = (await getBreakdown(scope, 'campaign_id', { campaignIds: [crm[0].id] }))[0];
    assert.equal(row.spend, 1200);

    // The campaign's budget is recorded (7b), Meta's controls refuse Google entities, and the
    // shared pause endpoint sends a Google campaign to the Google controls.
    const stored = (await db.query('SELECT id, budget_resource, budget_shared FROM ad_campaigns WHERE tenant_id = $1 AND external_id = $2', [t, '9001'])).rows[0];
    assert.deepEqual([stored.budget_resource, stored.budget_shared], ['customers/1234567890/campaignBudgets/31', false]);
    const { changeEntity } = require('../services/metaAds/controls');
    await assert.rejects(changeEntity({ tenantId: t, entityType: 'campaign', id: stored.id, action: 'pause' }), /not a Meta campaign/);
    await db.query("UPDATE ad_oauth_tokens SET status = 'expired' WHERE tenant_id = $1", [t]); // stop before any call to Google
    const paused = res();
    await require('../controllers/adsController').pauseCampaign({ tenantId: t, user: { id: null }, params: { id: stored.id }, body: {} }, paused);
    assert.equal(paused.code, 400);
    assert.match(paused.data.error, /Google Ads access has expired/, 'routed to the Google controls');

    // The shared job sends Google accounts to the Google sync.
    const { syncAccount } = require('../jobs/adsJobs');
    const routed = await syncAccount({ tenantId: t, adAccountId: crypto.randomUUID() });
    assert.deepEqual(routed, { skipped: 'not_found' });
  } finally {
    await db.query('DELETE FROM leads WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
});

test.after(async () => { if (db) await db.pool.end(); });
