const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gbp = require('../services/social/gbp');
const { profileHealth, summarizeInsights } = require('../services/gbpProfile');
const { loadProfiles, loadInsights } = require('../services/gmbConnection');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
// Shaped like Business Information API v1 locations.
const FULL = {
  name: 'locations/111', title: 'Salonox Hair Studio',
  storefrontAddress: { regionCode: 'IN', postalCode: '411001', administrativeArea: 'MH', locality: 'Pune', addressLines: ['12 MG Road'] },
  phoneNumbers: { primaryPhone: '+91 98765 43210', additionalPhones: ['+91 20 1234 5678'] }, websiteUri: 'https://salonox.com',
  categories: { primaryCategory: { name: 'categories/gcid:hair_salon', displayName: 'Hair salon' }, additionalCategories: [{ displayName: 'Beauty salon' }] },
  profile: { description: 'x'.repeat(300) }, regularHours: { periods: [{ openDay: 'MONDAY' }, { openDay: 'MONDAY' }, { openDay: 'TUESDAY' }] },
  metadata: { hasVoiceOfMerchant: true, mapsUri: 'https://maps.google.com/?cid=1', newReviewUri: 'https://search.google.com/local/writereview?placeid=abc' },
};

test('a Google location is mapped without inventing anything', () => {
  const d = gbp.mapLocation(FULL);
  assert.equal(d.name, 'Salonox Hair Studio'); assert.equal(d.primary_category, 'Hair salon'); assert.deepEqual(d.additional_categories, ['Beauty salon']);
  assert.equal(d.phone, '+91 98765 43210'); assert.equal(d.website, 'https://salonox.com'); assert.deepEqual(d.open_days, ['MONDAY', 'TUESDAY']);
  assert.equal(d.verified, true); assert.equal(d.review_url, FULL.metadata.newReviewUri); assert.equal(d.address.locality, 'Pune');
  const empty = gbp.mapLocation({ name: 'locations/2' });
  assert.deepEqual([empty.name, empty.phone, empty.website, empty.primary_category, empty.description, empty.verified, empty.review_url], [null, null, null, null, null, null, null]);
  assert.deepEqual(empty.open_days, []); assert.deepEqual(gbp.mapLocation(undefined).additional_categories, []);
});

test('listLocations asks for the profile fields and keeps the old shape', async () => {
  const calls = [];
  const http = { get: async (url, cfg) => { calls.push([url, cfg.params]); return url.includes('mybusinessaccountmanagement') ? { data: { accounts: [{ name: 'accounts/9' }] } } : { data: { locations: [FULL] } }; } };
  const out = await gbp.listLocations({ accessToken: 't', http });
  assert.equal(calls[1][1].readMask, gbp.LOCATION_READ_MASK);
  for (const f of ['phoneNumbers', 'websiteUri', 'categories', 'metadata', 'profile', 'regularHours']) assert.match(gbp.LOCATION_READ_MASK, new RegExp(f));
  assert.equal(out[0].external_id, 'locations/111'); assert.equal(out[0].parent_external_id, 'accounts/9'); assert.equal(out[0].address, '12 MG Road, Pune');
  assert.equal(out[0].details.review_url, FULL.metadata.newReviewUri);
});

test('profile health: a complete listing is strong, a bare one says exactly what to fix, weights add to 100', () => {
  const { CHECKS } = require('../services/gbpProfile');
  assert.equal(CHECKS.reduce((a, c) => a + c.weight, 0), 100);
  const full = profileHealth(gbp.mapLocation(FULL));
  assert.equal(full.score, 100); assert.equal(full.band, 'strong'); assert.deepEqual(full.to_fix, []);
  const bare = profileHealth(gbp.mapLocation({ name: 'locations/2', title: 'X' }));
  assert.equal(bare.band, 'weak');
  assert.equal(bare.score, 0, 'scored only over what Google told us; "verified" was not reported so it is not counted against the listing');
  assert.equal(bare.checks.find((c) => c.id === 'verified').ok, null);
  assert.ok(bare.to_fix[0].weight >= bare.to_fix[bare.to_fix.length - 1].weight, 'biggest wins first');
  assert.match(bare.to_fix.find((c) => c.id === 'description').fix, /250 to 750/);
  const short = profileHealth({ ...gbp.mapLocation(FULL), description: 'too short' });
  assert.equal(short.checks.find((c) => c.id === 'description').ok, false); assert.equal(short.score, 88);
  const unverified = profileHealth({ ...gbp.mapLocation(FULL), verified: false });
  assert.equal(unverified.score, 80); assert.equal(unverified.band, 'fair');
  assert.match(full.note, /not a ranking/);
  assert.equal(profileHealth(undefined).checks.length, 8);
});

test('insights: totals split maps vs search, actions counted, missing days are zero, no division by zero', () => {
  const ts = (metric, vals) => ({ dailyMetric: metric, timeSeries: { datedValues: vals.map(([d, v]) => ({ date: { year: 2026, month: 10, day: d }, ...(v == null ? {} : { value: String(v) }) })) } });
  const rows = [{ dailyMetricTimeSeries: [
    ts('BUSINESS_IMPRESSIONS_MOBILE_MAPS', [[1, 100], [2, 50]]), ts('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', [[1, 30], [2, null]]),
    ts('CALL_CLICKS', [[1, 5]]), ts('WEBSITE_CLICKS', [[2, 3]]), ts('BUSINESS_DIRECTION_REQUESTS', [[1, 2]]),
  ] }];
  const s = summarizeInsights(rows, { from: '2026-10-01', to: '2026-10-02' });
  assert.deepEqual(s.views, { total: 180, maps: 150, search: 30 });
  assert.deepEqual(s.actions, { calls: 5, website_clicks: 3, directions: 2, total: 10 });
  assert.equal(s.action_rate_pct, 5.6);
  assert.deepEqual(s.series, [{ date: '2026-10-01', views: 130, actions: 7 }, { date: '2026-10-02', views: 50, actions: 3 }]);
  const none = summarizeInsights([]);
  assert.equal(none.views.total, 0); assert.equal(none.action_rate_pct, null); assert.deepEqual(none.series, []);
  assert.equal(summarizeInsights(undefined).actions.total, 0);
});

test('fetchInsights builds a repeated-metrics query, validates the location, and wraps Google errors', async () => {
  let url;
  const http = { get: async (u) => { url = u; return { data: { multiDailyMetricTimeSeries: [{ x: 1 }] } }; } };
  const rows = await gbp.fetchInsights({ accessToken: 't', location: 'locations/123', from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z'), http });
  assert.deepEqual(rows, [{ x: 1 }]);
  assert.match(url, /locations\/123:fetchMultiDailyMetricsTimeSeries\?/);
  assert.equal((url.match(/dailyMetrics=/g) || []).length, gbp.INSIGHT_METRICS.length);
  assert.match(url, /dailyRange\.startDate\.year=2026.*dailyRange\.startDate\.month=9.*dailyRange\.startDate\.day=1/);
  assert.match(url, /dailyRange\.endDate\.day=30/);
  await assert.rejects(gbp.fetchInsights({ accessToken: 't', location: 'accounts/1', from: new Date(), to: new Date(), http }), /Choose one of your business locations/);
  await assert.rejects(gbp.fetchInsights({ accessToken: 't', location: '../x', from: new Date(), to: new Date(), http }), /Choose/);
  const denied = { get: async () => { const e = new Error('x'); e.response = { status: 403, data: { error: { message: 'API not enabled', details: [{ reason: 'SERVICE_DISABLED' }] } } }; throw e; } };
  await assert.rejects(gbp.fetchInsights({ accessToken: 't', location: 'locations/1', from: new Date(), to: new Date(), http: denied }), (e) => e.reason === 'SERVICE_DISABLED' && e.status === 403);
});

test('loadProfiles / loadInsights: success shapes, the same customer-safe error codes, and a bounded date range', async () => {
  const settings = { gmb_refresh_token_encrypted: 'x' };
  const ok = { accessTokenFor: async () => 'tok' };
  const p = await loadProfiles(settings, { ...ok, listLocations: async () => [{ external_id: 'locations/111', parent_external_id: 'accounts/9', name: 'Salonox', address: 'Pune', details: gbp.mapLocation(FULL) }] });
  assert.equal(p.ok, true); assert.equal(p.locations[0].health.score, 100); assert.equal(p.locations[0].id, 'locations/111');
  const err = (status, reason, message = 'x') => Object.assign(new gbp.GbpError(message, { status, reason }), {});
  assert.equal((await loadProfiles(settings, { ...ok, listLocations: async () => { throw err(403, 'SERVICE_DISABLED'); } })).code, 'api_not_enabled');
  assert.equal((await loadProfiles(settings, { ...ok, listLocations: async () => { throw err(429); } })).code, 'rate_limited');
  assert.equal((await loadProfiles(settings, { accessTokenFor: async () => { throw err(undefined, undefined, 'The Google connection has expired — reconnect Google in Integrations.'); } })).code, 'reconnect');

  let range;
  const now = new Date('2026-10-18T10:00:00Z');
  const i = await loadInsights(settings, { location: 'locations/111', days: 30, now }, { ...ok, fetchInsights: async (a) => { range = a; return []; } });
  assert.equal(i.ok, true); assert.equal(i.to, '2026-10-16', 'the last two days are not final, so they are left out'); assert.equal(i.from, '2026-09-17'); assert.equal(i.days, 30);
  assert.equal(range.location, 'locations/111');
  const big = await loadInsights(settings, { location: 'locations/111', days: 99999, now }, { ...ok, fetchInsights: async () => [] });
  assert.equal(big.days, 540);
  assert.equal((await loadInsights(settings, { location: 'locations/111', days: 'abc', now }, { ...ok, fetchInsights: async () => [] })).days, 30);
});

test('the routes are administrator-only, and nothing here edits a Google listing', () => {
  const routes = read('routes/gmb.js');
  assert.match(routes, /router\.get\('\/profiles', admin, getProfiles\)/); assert.match(routes, /router\.get\('\/insights', admin, getInsights\)/);
  const ctl = read('controllers/gmbController.js');
  assert.match(ctl, /\^locations\\\/\\d\+\$/, 'the location is validated before it reaches Google');
  const svc = (read('services/gbpProfile.js') + read('services/gmbConnection.js')).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(svc, /\.(post|put|patch|delete)\(/);
  assert.doesNotMatch(read('services/gbpProfile.js').replace(/\/\/.*$/gm, ''), /require\(|query\(/);
});
