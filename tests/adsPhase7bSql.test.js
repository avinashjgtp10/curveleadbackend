// Phase 7b against real PostgreSQL (fake Google responses): Google controls update the
// cache, CRM campaign and audit log; the budget cap counts a shared budget once; Google AI
// drafts are stored, kept apart from Meta drafts, created and activated.
// Skipped unless BATCH1_TEST_DATABASE_URL is set (see tests/batch1Sql.test.js); needs
// models/migration_ads_phase7b.sql applied.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.BATCH1_TEST_DATABASE_URL;
let db = null;
if (url) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase7b-test-secret';
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-token';
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });
  db = { pool, query: (t, p) => pool.query(t, p),
    transaction: async (fn) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } } };
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('../config/db', db);
  stub('../jobs/queues', { enqueue: async () => ({}) });
  stub('../services/groqService', { callGroq: async () => ({ content: JSON.stringify({
    campaign_name: 'Search – Hair spa Pune', path1: 'hair-spa', path2: 'pune', reasoning: 'Local intent.',
    headlines: ['Hair Spa in Pune', 'Diwali Offer at ₹999', 'Book Your Slot Today', 'Relaxing Hair Spa', 'Glow Salon Pune', 'Expert Stylists', 'Open 7 Days', 'Walk-ins Welcome', 'This headline is far too long for Google'],
    descriptions: ['Deep-conditioning hair spa by trained stylists. Book online in a minute.', 'Diwali special at ₹999 this month only. Slots fill fast.'],
    keywords: [{ text: 'hair spa pune', match_type: 'PHRASE' }, { text: 'hair spa near me', match_type: 'EXACT' }], negative_keywords: ['jobs'],
  }) }) });
}
const skip = !url && 'set BATCH1_TEST_DATABASE_URL to run';
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const TZ = 'Asia/Kolkata';

test('Google controls, shared budgets and the change history, on the real schema', { skip }, async () => {
  const t = crypto.randomUUID(), admin = crypto.randomUUID();
  await db.query(`INSERT INTO tenants (id, name, slug, email, website, settings) VALUES ($1,'G',$2,$3,'https://glow.example',$4)`,
    [t, `g7b-${t.slice(0, 8)}`, `g7b-${t.slice(0, 8)}@example.test`, JSON.stringify({ timezone: TZ, country: 'IN' })]);
  try {
    await db.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_active) VALUES ($1,$2,'Admin',$3,'x','admin',true)`, [admin, t, `a-${t.slice(0, 8)}@example.test`]);
    const { saveGoogleToken } = require('../services/googleAds/accounts');
    const tokenId = await saveGoogleToken({ tenantId: t, userId: admin, externalUserId: 'g-sub', refreshToken: 'REFRESH', scopes: ['https://www.googleapis.com/auth/adwords'] });
    const acct = (await db.query(`INSERT INTO ad_accounts (tenant_id, provider, external_id, name, currency, timezone_name, token_id, is_primary) VALUES ($1,'google','1234567890','Glow Google','INR',$2,$3,true) RETURNING id`, [t, TZ, tokenId])).rows[0].id;

    // Two campaigns on one shared ₹800/day budget, one ad group.
    const shared = 'customers/1234567890/campaignBudgets/31';
    const { saveHierarchy } = require('../services/googleAds/sync');
    await saveHierarchy({ tenantId: t, adAccountId: acct,
      campaigns: [
        { external_id: '9001', name: 'Search – Pune', objective: 'SEARCH', status: 'ENABLED', effective_status: 'ACTIVE', daily_budget_paise: 80000, lifetime_budget_paise: null, budget_resource: shared, budget_shared: true },
        { external_id: '9002', name: 'Search – Baramati', objective: 'SEARCH', status: 'ENABLED', effective_status: 'ACTIVE', daily_budget_paise: 80000, lifetime_budget_paise: null, budget_resource: shared, budget_shared: true },
      ],
      adGroups: [{ external_id: '55', campaign_external_id: '9001', name: 'Hair spa', status: 'ENABLED', effective_status: 'ACTIVE', optimization_goal: 'SEARCH_STANDARD' }], ads: [] });

    const ads = require('../controllers/adsController');
    const req = (extra = {}) => ({ tenantId: t, user: { id: admin, role: 'admin' }, query: {}, params: {}, body: {}, ...extra });
    const settings = res();
    await ads.getAdsSettings(req(), settings);
    assert.equal(settings.data.active_daily_budget_paise, 80000, 'a shared budget counts once');

    // Pause campaign 9001 through the Google controls (fake Google, real database).
    const googleControls = require('../services/googleAds/controls');
    let status = 'ENABLED';
    const sent = [];
    const deps = {
      accessToken: async (rt) => { assert.equal(rt, 'REFRESH'); return 'AT'; },
      search: async ({ gaql }) => (/FROM ad_group/.test(gaql)
        ? [{ adGroup: { id: '55', name: 'Hair spa', status }, campaign: { id: '9001' } }]
        : [{ campaign: { id: '9001', name: 'Search – Pune', status, servingStatus: 'SERVING' },
          campaignBudget: { resourceName: shared, amountMicros: '800000000', period: 'DAILY', explicitlyShared: true, referenceCount: 2 } }]),
      mutate: async ({ operations }) => { sent.push(operations[0]); status = operations[0].campaignOperation?.update.status || operations[0].adGroupOperation?.update.status || status; return { mutateOperationResponses: [{}] }; },
    };
    const c9001 = (await db.query('SELECT id, campaign_id FROM ad_campaigns WHERE tenant_id = $1 AND external_id = $2', [t, '9001'])).rows[0];
    await googleControls.changeEntity({ tenantId: t, userId: admin, entityType: 'campaign', id: c9001.id, action: 'pause' }, deps);
    const after = (await db.query('SELECT status, effective_status FROM ad_campaigns WHERE id = $1', [c9001.id])).rows[0];
    assert.deepEqual([after.status, after.effective_status], ['PAUSED', 'PAUSED']);
    assert.equal((await db.query('SELECT status FROM campaigns WHERE id = $1', [c9001.campaign_id])).rows[0].status, 'paused', 'CRM campaign follows');

    // Ad group pause updates ad_adsets.
    status = 'ENABLED';
    const group = (await db.query('SELECT id FROM ad_adsets WHERE tenant_id = $1 AND external_id = $2', [t, '55'])).rows[0].id;
    await googleControls.changeEntity({ tenantId: t, userId: admin, entityType: 'adset', id: group, action: 'pause' }, deps);
    assert.equal((await db.query('SELECT status FROM ad_adsets WHERE id = $1', [group])).rows[0].status, 'PAUSED');

    // A shared budget is never changed from CurveLead.
    await assert.rejects(googleControls.changeEntity({ tenantId: t, entityType: 'campaign', id: c9001.id, action: 'update_budget', dailyBudgetPaise: 90000 }, deps), /shared by 2 campaigns/);
    assert.equal(sent.length, 2);

    // Change history per platform.
    const g = res(); await ads.listAudit(req({ query: { provider: 'google' } }), g);
    assert.deepEqual(g.data.entries.map(e => [e.action, e.entity_type, e.success, e.user_name]), [['pause', 'adset', true, 'Admin'], ['pause', 'campaign', true, 'Admin']]);
    const m = res(); await ads.listAudit(req({ query: { provider: 'meta' } }), m);
    assert.equal(m.data.entries.length, 0);
  } finally {
    await db.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
});

test('Google AI drafts: stored apart from Meta drafts, created in one request, activated after confirmation', { skip }, async () => {
  const t = crypto.randomUUID(), admin = crypto.randomUUID();
  await db.query(`INSERT INTO tenants (id, name, slug, email, website, settings) VALUES ($1,'G',$2,$3,'https://glow.example',$4)`,
    [t, `g7c-${t.slice(0, 8)}`, `g7c-${t.slice(0, 8)}@example.test`, JSON.stringify({ timezone: TZ, country: 'IN' })]);
  try {
    await db.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_active) VALUES ($1,$2,'Admin',$3,'x','admin',true)`, [admin, t, `a-${t.slice(0, 8)}@example.test`]);
    const { saveGoogleToken } = require('../services/googleAds/accounts');
    const tokenId = await saveGoogleToken({ tenantId: t, userId: admin, externalUserId: 'g-sub', refreshToken: 'REFRESH', scopes: [] });
    await db.query(`INSERT INTO ad_accounts (tenant_id, provider, external_id, name, currency, timezone_name, token_id, is_primary) VALUES ($1,'google','1234567890','Glow Google','INR',$2,$3,true)`, [t, TZ, tokenId]);

    const aiSearch = require('../services/googleAds/aiSearch');
    const draft = await aiSearch.generateDraft({ tenantId: t, userId: admin, brief: { offer: 'Diwali hair spa at 999 in Pune', location: 'Pune', budget_per_day_inr: 500, duration_days: 14 } });
    assert.equal(draft.brief.final_url, 'https://glow.example', 'the workspace website is the default landing page');
    assert.equal(draft.draft.headlines.length, 8, 'the over-long headline was dropped');
    assert.deepEqual(draft.errors, []);

    assert.equal((await aiSearch.listDrafts(t)).length, 1);
    assert.equal((await require('../services/metaAds/aiCampaign').listDrafts(t)).length, 0, 'not in the Meta wizard');
    await assert.rejects(require('../services/metaAds/aiCampaign').getDraft(t, draft.id), /not found/);

    const edited = await aiSearch.updateDraft({ tenantId: t, id: draft.id, draft: { ...draft.draft, headlines: [...draft.draft.headlines.slice(0, 7), 'Book Now!'] } });
    assert.ok(edited.errors.some(e => e.field === 'headlines.7'));
    await aiSearch.updateDraft({ tenantId: t, id: draft.id, draft: draft.draft });

    const { googleAccess } = require('../services/googleAds/controls');
    const sent = [];
    const deps = {
      googleAccess: (tenantId, adAccountId) => googleAccess(tenantId, adAccountId, { accessToken: async () => 'AT' }),
      call: async () => ({ geoTargetConstantSuggestions: [{ geoTargetConstant: { resourceName: 'geoTargetConstants/1007788', canonicalName: 'Pune,Maharashtra,India', targetType: 'City', status: 'ENABLED' } }] }),
      search: async () => [{ languageConstant: { code: 'en', resourceName: 'languageConstants/1000' } }],
      mutate: async ({ operations, customerId }) => {
        sent.push(operations); assert.equal(customerId, '1234567890');
        return { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/5' } }, { campaignResult: { resourceName: 'customers/1234567890/campaigns/6' } }] };
      },
    };
    const created = await aiSearch.createOnGoogle({ tenantId: t, userId: admin, id: draft.id }, deps);
    assert.equal(created.status, 'created');
    assert.equal(created.ids.campaign_id, '6');
    assert.equal(created.ids.location, 'Pune,Maharashtra,India');
    await assert.rejects(aiSearch.createOnGoogle({ tenantId: t, id: draft.id }, deps), /already/);
    assert.equal(sent.length, 1);

    const activated = await aiSearch.activate({ tenantId: t, userId: admin, id: draft.id, confirm: 'Search – Hair spa Pune' }, deps);
    assert.equal(activated.status, 'activated');
    const log = (await db.query("SELECT action, provider, success FROM ad_audit_log WHERE tenant_id = $1 ORDER BY created_at", [t])).rows;
    assert.deepEqual(log.map(r => [r.action, r.provider, r.success]), [['create', 'google', true], ['activate', 'google', true]]);
  } finally {
    await db.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
});

test.after(async () => { if (db) await db.pool.end(); });
