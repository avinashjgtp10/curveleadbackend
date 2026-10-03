const test = require('node:test');
const assert = require('node:assert/strict');

// Phase 7a: Google Ads (read).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase7-test-secret';
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-token';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'secret';

const gads = require('../utils/googleAds');
const { parseCampaign, parseAdGroup, parseAd, parseMetrics, effectiveStatus } = require('../services/googleAds/sync');
const { accountsFromCustomers, discoverGoogleAccounts } = require('../services/googleAds/accounts');

test('campaign rows: budget micros → paise, status → the Ads screens’ vocabulary', () => {
  const c = parseCampaign({ campaign: { id: '123', name: 'Search – Pune', status: 'ENABLED', servingStatus: 'SERVING', advertisingChannelType: 'SEARCH' },
    campaignBudget: { amountMicros: '500000000', period: 'DAILY' } });
  assert.deepEqual(c, { external_id: '123', name: 'Search – Pune', objective: 'SEARCH', status: 'ENABLED', effective_status: 'ACTIVE', daily_budget_paise: 50000, lifetime_budget_paise: null });
  const total = parseCampaign({ campaign: { id: '9', status: 'ENABLED', servingStatus: 'ENDED' }, campaignBudget: { totalAmountMicros: '20000000000', period: 'CUSTOM_PERIOD' } });
  assert.equal(total.lifetime_budget_paise, 2000000);
  assert.equal(total.daily_budget_paise, null);
  assert.equal(total.effective_status, 'ENDED');
  assert.equal(effectiveStatus('PAUSED', 'SERVING'), 'PAUSED');
});

test('ad group and responsive search ad rows', () => {
  assert.deepEqual(parseAdGroup({ adGroup: { id: '55', name: 'Hair spa', status: 'ENABLED', type: 'SEARCH_STANDARD' }, campaign: { id: '123' } }),
    { external_id: '55', campaign_external_id: '123', name: 'Hair spa', status: 'ENABLED', effective_status: 'ACTIVE', optimization_goal: 'SEARCH_STANDARD' });
  const ad = parseAd({ adGroup: { id: '55' }, adGroupAd: { status: 'ENABLED', policySummary: { approvalStatus: 'DISAPPROVED' },
    ad: { id: '777', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://glow.example'], responsiveSearchAd: { headlines: [{ text: 'Hair Spa in Pune' }, { text: 'Book Today' }], descriptions: [{ text: 'Relax with…' }] } } } });
  assert.equal(ad.name, 'Hair Spa in Pune');
  assert.equal(ad.effective_status, 'DISAPPROVED');
  assert.deepEqual(ad.creative, { title: 'Hair Spa in Pune', body: 'Relax with…', headlines: ['Hair Spa in Pune', 'Book Today'], descriptions: ['Relax with…'], final_url: 'https://glow.example', type: 'RESPONSIVE_SEARCH_AD' });
});

test('daily metrics: cost micros → money, conversions rounded to leads (fractions kept)', () => {
  const r = parseMetrics({ campaign: { id: '123' }, segments: { date: '2026-10-01' }, metrics: { costMicros: '1234560000', impressions: '1000', clicks: '40', conversions: 2.6 } }, 'campaign');
  assert.deepEqual(r, { entity_id: '123', date: '2026-10-01', spend: 1234.56, impressions: 1000, clicks: 40, ctr: 4, cpc: 30.864, leads: 3, cpl: 411.52,
    actions: { conversions: 2.6 }, campaign_external_id: '123', adset_external_id: null });
  const ad = parseMetrics({ campaign: { id: '1' }, adGroup: { id: '2' }, adGroupAd: { ad: { id: '3' } }, segments: { date: '2026-10-01' }, metrics: {} }, 'ad');
  assert.deepEqual([ad.entity_id, ad.adset_external_id, ad.spend, ad.leads, ad.ctr, ad.cpl], ['3', '2', 0, 0, null, null]);
});

test('accounts: direct access wins, client accounts come through their manager, managers are not ad accounts', () => {
  const out = accountsFromCustomers({
    direct: [{ id: '1', manager: true }, { id: '2', manager: false, name: 'Direct' }],
    children: { 1: [{ id: '2', manager: false }, { id: '3', manager: false, name: 'Via MCC' }, { id: '4', manager: true }] },
  });
  assert.deepEqual(out.map(a => [a.id, a.login_customer_id]), [['2', null], ['3', '1']]);
});

test('discovery lists a manager’s clients and skips accounts it can’t open', async () => {
  const saved = [];
  const search = async ({ customerId, gaql, loginCustomerId }) => {
    if (/FROM customer_client/.test(gaql)) { assert.equal(loginCustomerId, '111'); return [{ customerClient: { id: '333', descriptiveName: 'Salon', currencyCode: 'INR', timeZone: 'Asia/Kolkata', manager: false, status: 'ENABLED' } }]; }
    if (customerId === '999') throw new gads.GoogleAdsError('cancelled', { code: 'CUSTOMER_NOT_ENABLED' });
    return [{ customer: { id: customerId, descriptiveName: `C${customerId}`, manager: customerId === '111', status: 'ENABLED', currencyCode: 'INR', timeZone: 'Asia/Kolkata' } }];
  };
  const r = await discoverGoogleAccounts({ tenantId: 't1', tokenId: 'tok', accessToken: 'a',
    deps: { search, listAccessibleCustomers: async () => ['111', '222', '999'], query: async (sql, p) => { saved.push(p); return { rows: [] }; } } });
  assert.equal(r.accounts, 2);
  assert.deepEqual(r.skipped.map(s => s.id), ['999']);
  assert.deepEqual(saved.map(p => [p[0], p[1], p[7]]), [['t1', '222', null], ['t1', '333', '111']], 'tenant first; client saved with its manager id');
  assert.equal(saved[0][5], 1, 'ENABLED → status 1');
});

test('API calls send the developer token and manager id, retry throttling, and explain errors', async () => {
  const seen = [];
  let n = 0;
  const http = { request: async (o) => {
    seen.push(o);
    if (n++ === 0) throw Object.assign(new Error('429'), { response: { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED', message: 'slow down' } } } });
    return { data: { results: [{ campaign: { id: '1' } }], nextPageToken: n < 3 ? 'p2' : undefined } };
  } };
  const rows = await gads.search({ customerId: '123-456-7890', gaql: 'SELECT campaign.id FROM campaign', accessToken: 'at', loginCustomerId: '111-222-3333', http, _sleep: async () => {} });
  assert.equal(rows.length, 2, 'two pages');
  assert.match(seen[0].url, /\/customers\/1234567890\/googleAds:search$/);
  assert.equal(seen[0].headers['developer-token'], 'dev-token');
  assert.equal(seen[0].headers['login-customer-id'], '1112223333');
  assert.equal(seen[2].data.pageToken, 'p2');

  const denied = { request: async () => { throw Object.assign(new Error('403'), { response: { status: 403, data: { error: { status: 'PERMISSION_DENIED',
    details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'x' }] }] } } } }); } };
  await assert.rejects(gads.call({ path: '/x', accessToken: 'a', http: denied, _sleep: async () => {} }),
    (e) => e.code === 'DEVELOPER_TOKEN_NOT_APPROVED' && !e.retryable && /Basic Access/.test(e.message));
  const expired = { request: async () => { throw Object.assign(new Error('401'), { response: { status: 401, data: { error: { status: 'UNAUTHENTICATED', message: 'bad token' } } } }); } };
  await assert.rejects(gads.call({ path: '/x', accessToken: 'a', http: expired }), (e) => e.auth && !e.retryable);
});

test('without a developer token nothing is called and the reason is clear', async () => {
  const saved = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  try {
    assert.equal(gads.configured(), false);
    await assert.rejects(gads.call({ path: '/x', accessToken: 'a', http: { request: async () => assert.fail('called') } }), /GOOGLE_ADS_DEVELOPER_TOKEN is missing/);
  } finally { process.env.GOOGLE_ADS_DEVELOPER_TOKEN = saved; }
});

test('the OAuth state ties the callback to the workspace that started it', () => {
  const url = new URL(gads.authUrl({ tenantId: 't1', userId: 'u1' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /auth\/adwords/);
  const s = gads.parseState(url.searchParams.get('state'));
  assert.deepEqual([s.tenantId, s.userId], ['t1', 'u1']);
  assert.throws(() => gads.parseState('tampered'));
  const { encryptSecret } = require('../utils/cryptoSecrets');
  assert.throws(() => gads.parseState(encryptSecret(JSON.stringify({ tenantId: 't1', ts: Date.now() - 11 * 60 * 1000, k: 'gads' }))), /expired/);
  assert.throws(() => gads.parseState(encryptSecret(JSON.stringify({ tenantId: 't1', ts: Date.now() }))), /Invalid/, 'a GBP state is not accepted');
});
