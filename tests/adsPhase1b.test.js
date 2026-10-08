const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Phase 1b: Campaigns and Ads Manager share one Meta connection, sync and CPL formula.

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, Intl, process: { env: {} }, setTimeout, require: k => deps[k] || {} });
  return module.exports;
}
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

test('a Meta-synced campaign keeps its Meta-managed fields; other fields still update', async () => {
  const calls = [];
  const db = { query: async (sql, p) => {
    calls.push([sql, p]);
    if (sql.startsWith('SELECT meta_campaign_id')) return { rows: [{ meta_campaign_id: '120' }] };
    return { rows: [{ id: 'c1' }] };
  } };
  const ctrl = load('controllers/campaignController.js', { '../config/db': db, '../utils/dataQuality': { normalizeSource: s => s } });

  let r = res();
  await ctrl.updateCampaign({ params: { id: 'c1' }, tenantId: 't', body: { name: 'New name', budget: 999, status: 'paused' } }, r);
  assert.equal(r.code, 200);
  const update = calls.find(([sql]) => sql.startsWith('UPDATE campaigns'));
  assert.match(update[0], /name = \$3/);
  assert.doesNotMatch(update[0], /budget|status/);
  assert.deepEqual(Array.from(update[1]), ['c1', 't', 'New name']);

  r = res();
  await ctrl.updateCampaign({ params: { id: 'c1' }, tenantId: 't', body: { budget: 999 } }, r);
  assert.equal(r.code, 409);
  assert.match(r.data.error, /managed in Meta/);
});

test('a manual campaign can still change budget and status', async () => {
  let update;
  const db = { query: async (sql, p) => {
    if (sql.startsWith('SELECT meta_campaign_id')) return { rows: [{ meta_campaign_id: null }] };
    if (sql.startsWith('UPDATE campaigns')) update = [sql, p];
    return { rows: [{ id: 'c1' }] };
  } };
  const ctrl = load('controllers/campaignController.js', { '../config/db': db, '../utils/dataQuality': { normalizeSource: s => s } });
  const r = res();
  await ctrl.updateCampaign({ params: { id: 'c1' }, tenantId: 't', body: { budget: 5000, status: 'paused' } }, r);
  assert.equal(r.code, 200);
  assert.match(update[0], /budget = \$3, status = \$4/);
});

test('campaign ads come from Ads Manager tables, falling back to legacy meta_ads', async () => {
  const run = async (modernRows) => {
    const sqls = [];
    const db = { query: async (sql) => {
      sqls.push(sql);
      if (sql.startsWith('SELECT id FROM campaigns')) return { rows: [{ id: 'c1' }] };
      if (sql.includes('FROM ad_campaigns ac')) return { rows: modernRows };
      return { rows: [{ id: 'legacy', spend: '100', total_leads: '4', won_leads: '1' }] };
    } };
    const ctrl = load('controllers/campaignController.js', { '../config/db': db });
    const r = res();
    await ctrl.getCampaignAds({ params: { id: 'c1' }, tenantId: 't' }, r);
    return { r, sqls };
  };
  let { r, sqls } = await run([{ id: 'a1', meta_ad_id: '9', spend: 300, total_leads: '3', won_leads: '1' }]);
  assert.equal(r.data.source, 'ads_manager');
  assert.equal(r.data.ads[0].cpl, '100.00');
  assert.ok(!sqls.some(s => s.includes('FROM meta_ads')));

  ({ r } = await run([]));
  assert.equal(r.data.source, 'legacy');
  assert.equal(r.data.ads[0].id, 'legacy');
});

test('Click-to-WhatsApp attribution uses synced ads without calling Meta', async () => {
  let graphCalls = 0;
  const db = { query: async (sql) => {
    if (sql.includes('FROM ad_ads ad')) return { rows: [{ campaign_external_id: '120', campaign_name: 'Diwali', adset_id: '130', adset_name: 'Pune', ad_name: 'Video A' }] };
    if (sql.startsWith('SELECT id FROM campaigns')) return { rows: [{ id: 'crm-1' }] };
    return { rows: [] };
  } };
  const match = load('utils/metaCampaignMatch.js', {
    '../config/db': db, '../config/meta': { GRAPH_URL: 'https://graph' },
    axios: { get: async () => { graphCalls++; return { data: {} }; } },
  });
  const result = await match.resolveCampaignFromAdId({ tenantId: 't', adId: '999' });
  assert.deepEqual({ ...result }, { campaignId: 'crm-1', adName: 'Video A', adsetName: 'Pune' });
  assert.equal(graphCalls, 0);
});

test('lifetime campaign totals are written to the CRM campaigns by Meta campaign id', async () => {
  const updates = [];
  const insights = load('services/metaAds/insights.js', {
    '../../config/db': { query: async (sql, p) => { updates.push([sql, p]); return { rows: [] }; } },
    '../../utils/metaGraph': { graphPaged: async (opts) => {
      assert.equal(opts.params.date_preset, 'maximum');
      assert.equal(opts.params.level, 'campaign');
      return [{ campaign_id: '120', spend: '1500.50', impressions: '20000', clicks: '310' }];
    } },
    './parseInsights': { parseInsightsRow: () => ({}) },
  });
  assert.equal(await insights.syncLifetimeCampaignTotals({ tenantId: 't', externalAccountId: 'act_1', token: 'x' }), 1);
  assert.match(updates[0][0], /WHERE tenant_id = \$1 AND meta_campaign_id = \$2/);
  assert.deepEqual(Array.from(updates[0][1]), ['t', '120', 1500.5, 20000, 310]);
});

test('sync range accepts the DATE column as pg returns it (a Date), not only as text', () => {
  const { syncRange } = require('../services/metaAds/sync');
  const now = new Date('2026-10-03T06:00:00Z');
  const asDate = syncRange({ insights_synced_through: new Date(2026, 9, 3) }, now);   // local midnight, like pg
  const asText = syncRange({ insights_synced_through: '2026-10-03' }, now);
  assert.deepEqual(asDate, { since: '2026-10-01', until: '2026-10-03' });
  assert.deepEqual(asText, asDate);
  assert.equal(syncRange({ insights_synced_through: 'garbage' }, now).since, '2026-07-05'); // falls back to the 90-day backfill
});
