const test = require('node:test');
const assert = require('node:assert/strict');

// Phase 7b: Google Ads controls (pause/resume, budgets) and AI search ads (validated,
// created paused in one atomic request, activated only after confirmation).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase7b-test-secret';
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-token';

// In-memory stand-ins for the database and the job queue, swapped in before the services load.
const calls = [];
let handler = () => ({ rows: [] });
const fakeDb = {
  query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params) || { rows: [] }; },
  transaction: async (fn) => fn({ query: fakeDb.query }),
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/db', fakeDb);
stub('../jobs/queues', { enqueue: async () => ({}) });

const gads = require('../utils/googleAds');
const schema = require('../services/googleAds/aiSearchSchema');
const aiSearch = require('../services/googleAds/aiSearch');
const googleControls = require('../services/googleAds/controls');
const { dailyBudgetTotal } = require('../services/metaAds/controls');
const { schemaErrorMessage } = require('../utils/schemaErrors');

const reset = (h) => { calls.length = 0; handler = h || (() => ({ rows: [] })); };
const audits = () => calls.filter(c => /INSERT INTO ad_audit_log/.test(c.sql)).map(c => ({ action: c.params[6], success: c.params[11], provider: c.params[13], error: c.params[12] }));

const good = (over = {}) => ({
  campaign_name: 'Search – Hair spa Pune', final_url: 'https://glow.example/hair-spa', path1: 'hair spa', path2: 'pune',
  location: 'Pune', language: 'en', daily_budget_inr: 500, duration_days: 14,
  headlines: ['Hair Spa in Pune', 'Diwali Offer at ₹999', 'Book Your Slot Today', 'Relaxing Hair Spa', 'Glow Salon Pune', 'Expert Stylists', 'Open 7 Days', 'Walk-ins Welcome'],
  descriptions: ['Deep-conditioning hair spa by trained stylists. Book online in a minute.', 'Diwali special at ₹999 this month only. Slots fill fast.'],
  keywords: ['hair spa pune', '[hair spa near me]', '"salon in pune"'], negative_keywords: ['jobs', 'course'],
  ...over,
});

// ── validation ─────────────────────────────────────────────────────────────
test('a sensible search draft passes; keywords and paths are normalised', () => {
  const { errors, warnings, draft } = schema.validateSearchDraft(good());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(draft.keywords, [
    { text: 'hair spa pune', match_type: 'PHRASE' }, { text: 'hair spa near me', match_type: 'EXACT' }, { text: 'salon in pune', match_type: 'PHRASE' }]);
  assert.equal(draft.path1, 'hair-spa', 'spaces become hyphens');
});

test('Google limits: 30/90 characters, 3–15 headlines, 2–4 descriptions, unique text, no "!" in headlines', () => {
  const { errors } = schema.validateSearchDraft(good({
    headlines: ['x'.repeat(31), 'Book Now!', 'Hair Spa in Pune', 'hair spa in pune'], descriptions: ['y'.repeat(91)],
    path1: 'a'.repeat(16), path2: '',
  }));
  const fields = errors.map(e => e.field);
  for (const f of ['headlines.0', 'headlines.1', 'headlines.3', 'descriptions', 'descriptions.0', 'path1']) assert.ok(fields.includes(f), f);
  assert.ok(schema.validateSearchDraft(good({ headlines: ['One', 'Two'] })).errors.some(e => e.field === 'headlines'));
  assert.ok(schema.validateSearchDraft(good({ headlines: ['One', 'Two', 'Three'] })).warnings.some(e => e.field === 'headlines'), 'fewer than 8 is a warning');
  assert.ok(schema.validateSearchDraft(good({ path1: '', path2: 'pune' })).errors.some(e => e.field === 'path1'));
});

test('editorial rules: phone numbers, repeated punctuation, banned claims, capitals, bad keyword symbols', () => {
  const copyErr = (over) => schema.validateSearchDraft(good(over)).errors.filter(e => e.field === 'copy').map(e => e.message).join(' ');
  assert.match(copyErr({ descriptions: ['Call 98765 43210 to book your hair spa today.', 'Second description here.'] }), /phone/);
  assert.match(copyErr({ descriptions: ['Book now!! Limited slots this week only.', 'Second description here.'] }), /punctuation/);
  assert.match(copyErr({ descriptions: ['100% guaranteed results for every client.', 'Second description here.'] }), /guarantees|100%/);
  assert.match(copyErr({ headlines: [...good().headlines.slice(0, 7), 'पक्की गारंटी'] }), /guarantees/);
  assert.ok(schema.validateSearchDraft(good({ headlines: [...good().headlines.slice(0, 7), 'FREE Consultation'] })).warnings.some(w => /capitals/.test(w.message)));
  assert.ok(!schema.validateSearchDraft(good({ headlines: [...good().headlines.slice(0, 7), '2 BHK Flats Pune'] })).warnings.length, 'acronyms are fine');
  const kw = schema.validateSearchDraft(good({ keywords: ['hair spa, pune', 'jobs'], negative_keywords: ['jobs'] })).errors.map(e => e.message).join(' ');
  assert.match(kw, /symbols/);
  assert.match(kw, /both a keyword and a negative/);
  assert.ok(schema.validateSearchDraft(good({ keywords: ['personal loan pune'] })).warnings.some(w => /financial services verification/.test(w.message)));
});

test('landing page, budget, duration and the workspace cap', () => {
  const fields = schema.validateSearchDraft(good({ final_url: 'glow.example', daily_budget_inr: 50, duration_days: 0 })).errors.map(e => e.field);
  for (const f of ['final_url', 'daily_budget_inr', 'duration_days']) assert.ok(fields.includes(f), f);
  const capped = schema.validateSearchDraft(good({ daily_budget_inr: 500 }), { capPaise: 100000, activeDailyPaise: 60000 });
  assert.ok(capped.errors.some(e => e.field === 'daily_budget_inr' && /cap/.test(e.message)));
});

test('the budget cap counts Google ENABLED campaigns and a shared budget once', () => {
  const campaigns = [
    { external_id: 'm1', status: 'ACTIVE', daily_budget_paise: 50000 },
    { external_id: 'g1', status: 'ENABLED', daily_budget_paise: 80000, budget_resource: 'customers/1/campaignBudgets/9' },
    { external_id: 'g2', status: 'ENABLED', daily_budget_paise: 80000, budget_resource: 'customers/1/campaignBudgets/9' },
    { external_id: 'g3', status: 'PAUSED', daily_budget_paise: 70000, budget_resource: 'customers/1/campaignBudgets/10' },
  ];
  assert.equal(dailyBudgetTotal(campaigns, []), 130000);
  assert.equal(dailyBudgetTotal(campaigns, [], { g3: { status: 'ENABLED' } }), 200000);
});

// ── the atomic create request ──────────────────────────────────────────────
test('one atomic request: budget → campaign (PAUSED) → targeting → ad group → keywords → ad', () => {
  const { draft: d } = schema.validateSearchDraft(good());
  const { ops, labels } = aiSearch.buildOperations({ d, customerId: '123-456-7890', geoTarget: 'geoTargetConstants/1007788',
    languages: [{ code: 'en', resourceName: 'languageConstants/1000' }], draftId: 'abcdef12-0000', now: Date.parse('2026-10-03T20:00:00Z'), timezone: 'Asia/Kolkata' });
  assert.equal(ops.length, labels.length);
  assert.deepEqual(ops.map(o => Object.keys(o)[0]), [
    'campaignBudgetOperation', 'campaignOperation', 'campaignCriterionOperation', 'campaignCriterionOperation',
    'campaignCriterionOperation', 'campaignCriterionOperation', 'adGroupOperation',
    'adGroupCriterionOperation', 'adGroupCriterionOperation', 'adGroupCriterionOperation', 'adGroupAdOperation']);
  const budget = ops[0].campaignBudgetOperation.create;
  assert.equal(budget.amountMicros, '500000000');
  assert.equal(budget.explicitlyShared, false);
  assert.match(budget.name, /abcdef12$/, 'unique budget name per draft');
  const c = ops[1].campaignOperation.create;
  assert.equal(c.status, 'PAUSED');
  assert.equal(c.resourceName, 'customers/1234567890/campaigns/-2');
  assert.equal(c.campaignBudget, 'customers/1234567890/campaignBudgets/-1');
  assert.equal(c.containsEuPoliticalAdvertising, 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING');
  assert.equal(c.networkSettings.targetContentNetwork, false);
  assert.equal(c.startDateTime, '2026-10-04 00:00:00', '20:00 UTC is already the 4th in India');
  assert.equal(c.endDateTime, '2026-10-17 23:59:59', '14 days including the first');
  assert.deepEqual(ops[4].campaignCriterionOperation.create, { campaign: 'customers/1234567890/campaigns/-2', negative: true, keyword: { text: 'jobs', matchType: 'BROAD' } });
  assert.deepEqual(ops[8].adGroupCriterionOperation.create.keyword, { text: 'hair spa near me', matchType: 'EXACT' });
  const ad = ops[10].adGroupAdOperation.create;
  assert.equal(ad.adGroup, 'customers/1234567890/adGroups/-3');
  assert.deepEqual(ad.ad.finalUrls, ['https://glow.example/hair-spa']);
  assert.equal(ad.ad.responsiveSearchAd.headlines.length, 8);
  assert.equal(ad.ad.responsiveSearchAd.path1, 'hair-spa');
});

test('rejections name the item Google refused; created ids are read from the response', () => {
  const labels = ['Budget', 'Campaign', 'Keyword "free hair spa"', 'Ad'];
  const e = new gads.GoogleAdsError('x', { errors: [{ code: 'POLICY', message: 'Keyword violates policy', trigger: 'free hair spa', path: [{ field: 'mutate_operations', index: 2 }] }] });
  assert.equal(aiSearch.explainMutateError(e, labels), 'Google Ads rejected it — Keyword "free hair spa": Keyword violates policy ("free hair spa")');
  assert.match(aiSearch.explainMutateError(new gads.GoogleAdsError('dup', { code: 'DUPLICATE_CAMPAIGN_NAME' }), labels), /already exists/);
  const ids = aiSearch.idsFromResponse({ mutateOperationResponses: [
    { campaignBudgetResult: { resourceName: 'customers/1/campaignBudgets/5' } }, { campaignResult: { resourceName: 'customers/1/campaigns/6' } },
    { adGroupCriterionResult: { resourceName: 'customers/1/adGroupCriteria/7~1' } }, { adGroupAdResult: { resourceName: 'customers/1/adGroupAds/7~8' } },
  ] }, labels);
  assert.deepEqual(ids, { keywords: 1, budget: 'customers/1/campaignBudgets/5', campaign: 'customers/1/campaigns/6', ad: 'customers/1/adGroupAds/7~8', campaign_id: '6' });
});

test('mutate is never retried and Google’s per-item errors are kept', async () => {
  let n = 0;
  const http = { request: async (o) => {
    n++;
    assert.match(o.url, /\/v25\/customers\/1234567890\/googleAds:mutate$/);
    assert.equal(o.data.validateOnly, true);
    throw Object.assign(new Error('500'), { response: { status: 500, data: { error: { status: 'INTERNAL', message: 'boom',
      details: [{ errors: [{ errorCode: { internalError: 'INTERNAL_ERROR' }, message: 'boom', trigger: { stringValue: 't' }, location: { fieldPathElements: [{ fieldName: 'mutate_operations', index: 3 }] } }] }] } } } });
  } };
  await assert.rejects(gads.mutate({ customerId: '123-456-7890', operations: [], accessToken: 'a', validateOnly: true, http }),
    (e) => e.retryable && e.errors[0].trigger === 't' && e.errors[0].path[0].index === 3);
  assert.equal(n, 1, 'a write that may have gone through is not repeated');
});

// ── controls ───────────────────────────────────────────────────────────────
const controlDeps = (over = {}) => {
  const mutations = [];
  let current = { campaign: { id: '9001', name: 'Search – Pune', status: 'ENABLED', servingStatus: 'SERVING' },
    campaignBudget: { resourceName: 'customers/123/campaignBudgets/55', amountMicros: '500000000', period: 'DAILY', explicitlyShared: false, referenceCount: 1 } };
  return {
    mutations,
    setCurrent: (fn) => { current = fn(current); },
    deps: {
      query: fakeDb.query, transaction: fakeDb.transaction,
      getGoogleAccountWithToken: async () => ({ account: { external_id: '123', currency: 'INR', token_status: 'active', login_customer_id: null }, refreshToken: 'rt' }),
      accessToken: async () => 'at',
      search: async () => [current],
      mutate: async ({ operations }) => {
        mutations.push(operations[0]);
        const op = operations[0];
        if (op.campaignOperation) current = { ...current, campaign: { ...current.campaign, status: op.campaignOperation.update.status } };
        if (op.campaignBudgetOperation) current = { ...current, campaignBudget: { ...current.campaignBudget, amountMicros: op.campaignBudgetOperation.update.amountMicros } };
        return { mutateOperationResponses: [{}] };
      },
      budgetCap: async () => null,
      workspaceBudgets: async () => ({ campaigns: [], adsets: [] }),
      ...over,
    },
  };
};
const entityRows = (sql) => (/FROM ad_campaigns ac WHERE/.test(sql) ? { rows: [{ id: 'c1', external_id: '9001', name: 'Search – Pune', ad_account_id: 'a1', crm_campaign_id: 'crm1' }] }
  : /FROM ad_adsets s JOIN/.test(sql) ? { rows: [{ id: 's1', external_id: '55', name: 'Hair spa', ad_account_id: 'a1' }] } : { rows: [] });

test('pausing a Google campaign: read first, one status update, cache + CRM + audit (provider google)', async () => {
  reset(entityRows);
  const { deps, mutations } = controlDeps();
  const r = await googleControls.changeEntity({ tenantId: 't1', userId: 'u1', entityType: 'campaign', id: 'c1', action: 'pause' }, deps);
  assert.deepEqual(mutations, [{ campaignOperation: { update: { resourceName: 'customers/123/campaigns/9001', status: 'PAUSED' }, updateMask: 'status' } }]);
  assert.equal(r.old_value.status, 'ENABLED');
  assert.equal(r.new_value.effective_status, 'PAUSED');
  assert.ok(calls.some(c => /UPDATE campaigns SET status/.test(c.sql) && c.params[2] === 'paused'));
  assert.deepEqual(audits(), [{ action: 'pause', success: true, provider: 'google', error: null }]);
  assert.ok(calls.every(c => c.params?.[0] === 't1' || !c.params), 'tenant is the first parameter everywhere');
});

test('budgets: changed on the campaign budget; shared budgets, ad groups and the cap are refused', async () => {
  reset(entityRows);
  let { deps, mutations } = controlDeps();
  const r = await googleControls.changeEntity({ tenantId: 't1', entityType: 'campaign', id: 'c1', action: 'update_budget', dailyBudgetPaise: 70000 }, deps);
  assert.deepEqual(mutations, [{ campaignBudgetOperation: { update: { resourceName: 'customers/123/campaignBudgets/55', amountMicros: '700000000' }, updateMask: 'amount_micros' } }]);
  assert.equal(r.new_value.daily_budget_paise, 70000);

  ({ deps, mutations } = controlDeps());
  const shared = controlDeps();
  shared.setCurrent(c => ({ ...c, campaignBudget: { ...c.campaignBudget, explicitlyShared: true, referenceCount: 3 } }));
  await assert.rejects(googleControls.changeEntity({ tenantId: 't1', entityType: 'campaign', id: 'c1', action: 'update_budget', dailyBudgetPaise: 70000 }, shared.deps),
    (e) => e.status === 422 && /shared by 3 campaigns/.test(e.message));
  assert.equal(shared.mutations.length, 0);

  await assert.rejects(googleControls.changeEntity({ tenantId: 't1', entityType: 'adset', id: 's1', action: 'update_budget', dailyBudgetPaise: 70000 }, deps),
    (e) => e.status === 422 && /ad groups don't have their own budget/.test(e.message));

  const capped = controlDeps({ budgetCap: async () => 60000, workspaceBudgets: async () => ({ campaigns: [{ external_id: '9001', status: 'ENABLED', daily_budget_paise: 50000 }], adsets: [] }) });
  await assert.rejects(googleControls.changeEntity({ tenantId: 't1', entityType: 'campaign', id: 'c1', action: 'update_budget', dailyBudgetPaise: 70000 }, capped.deps),
    (e) => e.status === 422 && /above your cap/.test(e.message));
  assert.equal(capped.mutations.length, 0);
});

test('resume of an already-enabled campaign changes nothing; a Google failure is audited', async () => {
  reset(entityRows);
  const { deps, mutations } = controlDeps();
  assert.equal((await googleControls.changeEntity({ tenantId: 't1', entityType: 'campaign', id: 'c1', action: 'resume' }, deps)).unchanged, true);
  assert.equal(mutations.length, 0);

  reset(entityRows);
  const broken = controlDeps({ mutate: async () => { throw new gads.GoogleAdsError('Google Ads: not allowed', { status: 403, code: 'X' }); } });
  await assert.rejects(googleControls.changeEntity({ tenantId: 't1', entityType: 'adset', id: 's1', action: 'pause' },
    { ...broken.deps, search: async () => [{ adGroup: { id: '55', name: 'Hair spa', status: 'ENABLED' }, campaign: { id: '9001' } }] }),
  (e) => e.status === 400 && /not allowed/.test(e.message));
  assert.deepEqual(audits(), [{ action: 'pause', success: false, provider: 'google', error: 'Google Ads: not allowed' }]);
});

// ── create / activate ──────────────────────────────────────────────────────
const draftRow = (over = {}) => ({ id: 'd1', tenant_id: 't1', ad_account_id: 'a1', provider: 'google', status: 'draft', brief: {}, edited: schema.validateSearchDraft(good()).draft,
  meta_ids: {}, api_log: [], ...over });
const dbFor = (row) => (sql) => {
  if (/UPDATE ad_ai_drafts SET status = 'creating'/.test(sql)) return { rows: row.status === 'draft' || row.status === 'failed' ? [row] : [] };
  if (/SELECT \* FROM ad_ai_drafts/.test(sql)) return { rows: [row] };
  if (/SELECT settings FROM tenants/.test(sql)) return { rows: [{ settings: { country: 'IN' } }] };
  return { rows: [] };
};
const access = async () => ({ account: { external_id: '123', currency: 'INR', timezone_name: 'Asia/Kolkata' }, opts: { customerId: '123', accessToken: 'at' } });

test('create: one atomic mutate, saved as created (paused); a rejection marks the draft failed with the reason', async () => {
  reset(dbFor(draftRow()));
  const sent = [];
  const deps = {
    googleAccess: access,
    call: async ({ path, data }) => { assert.equal(path, '/geoTargetConstants:suggest'); assert.deepEqual(data.locationNames.names, ['Pune']);
      return { geoTargetConstantSuggestions: [{ geoTargetConstant: { resourceName: 'geoTargetConstants/1007788', canonicalName: 'Pune,Maharashtra,India', targetType: 'City', status: 'ENABLED' } }] }; },
    search: async () => [{ languageConstant: { code: 'en', resourceName: 'languageConstants/1000' } }],
    mutate: async ({ operations }) => { sent.push(operations); return { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: 'customers/123/campaignBudgets/5' } }, { campaignResult: { resourceName: 'customers/123/campaigns/6' } }] }; },
  };
  await aiSearch.createOnGoogle({ tenantId: 't1', userId: 'u1', id: 'd1' }, deps);
  assert.equal(sent.length, 1, 'everything in one request');
  assert.equal(sent[0][1].campaignOperation.create.status, 'PAUSED');
  const saved = calls.find(c => /UPDATE ad_ai_drafts SET api_log/.test(c.sql) && c.params.includes('created'));
  assert.ok(saved, 'status created');
  assert.equal(JSON.parse(saved.params[3]).campaign_id, '6');
  assert.deepEqual(audits(), [{ action: 'create', success: true, provider: 'google', error: null }]);

  reset(dbFor(draftRow()));
  await assert.rejects(aiSearch.createOnGoogle({ tenantId: 't1', id: 'd1' }, { ...deps,
    mutate: async () => { throw new gads.GoogleAdsError('bad', { status: 400, errors: [{ message: 'Too long', trigger: null, path: [{ field: 'mutate_operations', index: 1 }] }] }); } }),
  (e) => e.status === 400 && /Campaign: Too long/.test(e.message));
  assert.ok(calls.some(c => /UPDATE ad_ai_drafts SET api_log/.test(c.sql) && c.params.includes('failed')));

  reset(dbFor(draftRow({ status: 'created' })));
  await assert.rejects(aiSearch.createOnGoogle({ tenantId: 't1', id: 'd1' }, deps), (e) => e.status === 409);
});

test('create refuses a draft that no longer validates, before calling Google', async () => {
  reset(dbFor(draftRow({ edited: { ...draftRow().edited, headlines: ['Only one'] } })));
  let called = false;
  await assert.rejects(aiSearch.createOnGoogle({ tenantId: 't1', id: 'd1' }, { googleAccess: access, mutate: async () => { called = true; } }), (e) => e.status === 422);
  assert.equal(called, false);
});

test('activate needs the exact campaign name, then enables it and moves the end date', async () => {
  const row = draftRow({ status: 'created', meta_ids: { campaign: 'customers/123/campaigns/6', campaign_id: '6' } });
  reset(dbFor(row));
  const sent = [];
  const deps = { googleAccess: access, mutate: async ({ operations }) => { sent.push(operations[0]); return {}; } };
  await assert.rejects(aiSearch.activate({ tenantId: 't1', id: 'd1', confirm: 'search' }, deps), (e) => e.status === 422);
  assert.equal(sent.length, 0);
  await aiSearch.activate({ tenantId: 't1', id: 'd1', confirm: ' Search – Hair spa Pune ', now: Date.parse('2026-10-10T06:00:00Z') }, deps);
  assert.deepEqual(sent, [{ campaignOperation: { update: { resourceName: 'customers/123/campaigns/6', status: 'ENABLED', endDateTime: '2026-10-23 23:59:59' }, updateMask: 'status,end_date_time' } }]);
  assert.ok(calls.some(c => /SET status = 'activated'/.test(c.sql)));
  assert.deepEqual(audits().map(a => [a.action, a.success, a.provider]), [['activate', true, 'google']]);
});

test('the AI brief needs a landing page; over-long variants are dropped only when enough remain', () => {
  assert.throws(() => aiSearch.validateBrief({ offer: 'Hair spa at 999 in Pune', location: 'Pune', budget_per_day_inr: 500, duration_days: 14 }), /land/);
  assert.equal(aiSearch.validateBrief({ offer: 'Hair spa at 999 in Pune', location: 'Pune', budget_per_day_inr: 500, duration_days: 14 }, { website: 'https://glow.example' }).final_url, 'https://glow.example');
  const many = [...Array(9)].map((_, i) => `Headline ${i}`);
  assert.deepEqual(aiSearch.trimOverLong([...many, 'x'.repeat(40)], 30, 8), many);
  assert.equal(aiSearch.trimOverLong(['ok', 'x'.repeat(40)], 30, 8).length, 2, 'kept for the user to shorten');
});

test('missing 7b columns point at the 7b migration', () => {
  assert.match(schemaErrorMessage({ code: '42703', message: 'column "budget_resource" of relation "ad_campaigns" does not exist' }), /migration_ads_phase7b/);
  assert.match(schemaErrorMessage({ code: '42703', message: 'column "provider" of relation "ad_ai_drafts" does not exist' }), /migration_ads_phase7b/);
  assert.match(schemaErrorMessage({ code: '42703', message: 'column a.provider does not exist' }), /migration_ads_phase7b/);
});
