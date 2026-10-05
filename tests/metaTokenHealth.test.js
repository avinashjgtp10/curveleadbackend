const test = require('node:test');
const assert = require('node:assert/strict');

// Facebook login health: which ad permissions a login has (granted / declined / never
// offered), and Graph error 190 (Facebook ended the login) during ad sync, posting and
// lead fetch — the connection is marked expired with the subcode and nothing retries it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'token-health-test-secret';

// In-memory stand-ins, swapped in before the modules under test load.
const calls = [];
let handler = () => ({ rows: [] });
const fakeDb = {
  query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params) || { rows: [] }; },
  transaction: async (fn) => fn({ query: fakeDb.query }),
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const enqueued = [];
stub('../config/db', fakeDb);
stub('../jobs/queues', { enqueue: async (...a) => { enqueued.push(a); return {}; }, register() {}, repeat() {} });

// Graph calls are faked per test; the real MetaGraphError class is kept.
const realGraph = require('../utils/metaGraph');
const { MetaGraphError } = realGraph;
let graph = async () => { throw new Error('graph not faked'); };
stub('../utils/metaGraph', { ...realGraph, graphRequest: (o) => graph(o), graphPaged: (o) => graph(o) });

// Meta client faked for the connect endpoint and the sync. Modules keep references to these
// functions, so tests change `client.inspect` / `client.perms`, not the exported functions.
const client = {
  inspect: async () => ({ is_valid: true, user_id: 'fb1', scopes: [], expires_at: null }),
  perms: async () => [], saved: [],
};
stub('../services/metaAds/client', {
  exchangeForLongLived: async () => 'LONG', inspectToken: (t) => client.inspect(t), fetchPermissions: (t) => client.perms(t),
  saveToken: async (a) => { client.saved.push(a); return 'tok1'; }, syncAccountsForToken: async () => 2,
  getAccountWithToken: async () => ({ account: { is_active: true, token_status: 'active', token_row_id: 'tok1', external_id: 'act_1' }, token: 'T' }),
  markToken: async () => {},
});
stub('../services/metaAds/hierarchy', { fetchHierarchy: async () => graph({ path: 'hierarchy' }), saveHierarchy: async () => {} });

const health = require('../services/metaAds/tokenHealth');
const ads = require('../controllers/adsController');
const { syncAdAccount } = require('../services/metaAds/sync');
const { publishPost } = require('../services/social/publisher');
const metaLeads = require('../services/metaLeads');
const { verdict, run: checkTokens } = require('../scripts/checkMetaTokens');

const reset = (h) => { calls.length = 0; handler = h || (() => ({ rows: [] })); client.saved.length = 0; enqueued.length = 0; };
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const dead = (subcode = 460) => new MetaGraphError({ code: 190, error_subcode: subcode, message: 'Error validating access token: The session has been invalidated.' }, 400);

// ── permissions ────────────────────────────────────────────────────────────
test('granted: ads_read (or ads_management) is enough; the four ad permissions are reported', () => {
  const s = health.classifyPermissions({ granted: ['ads_read', 'business_management', 'public_profile'], permissions: [{ permission: 'leads_retrieval', status: 'declined' }] });
  assert.deepEqual(s.byName, { ads_read: 'granted', ads_management: 'missing', business_management: 'granted', leads_retrieval: 'declined' });
  assert.equal(health.adsAccessProblem(s), null);
  assert.equal(health.adsAccessProblem(health.classifyPermissions({ granted: ['ads_management'] })), null);
});

test('declined: the person turned ad access off → Reconnect message', () => {
  const s = health.classifyPermissions({ granted: ['pages_show_list'], permissions: [{ permission: 'ads_read', status: 'declined' }, { permission: 'pages_show_list', status: 'granted' }] });
  assert.deepEqual(health.adsAccessProblem(s), { code: 'ADS_READ_DECLINED', message: 'You turned off ad access during Facebook login. Click Reconnect and allow ad account access.' });
  assert.deepEqual(s.allDeclined, ['ads_read']);
});

test('missing: never offered (no role on the Meta app) → contact support message', () => {
  const s = health.classifyPermissions({ granted: ['business_management', 'leads_retrieval'], permissions: [{ permission: 'business_management', status: 'granted' }] });
  assert.deepEqual(health.adsAccessProblem(s), { code: 'ADS_READ_NOT_APPROVED',
    message: 'Your Facebook account isn\'t approved for CurveLead ads access yet. Contact CurveLead support to be added as a tester, then click Connect again.' });
});

test('connect endpoint: granted saves the granted and declined lists; declined / missing refuse with their code', async () => {
  const req = { tenantId: 't1', user: { id: 'u1' }, body: { user_token: 'x'.repeat(30) } };
  reset(() => ({ rows: [{ id: 'a1' }] }));
  client.inspect = async () => ({ is_valid: true, user_id: 'fb1', scopes: ['ads_read', 'business_management'], expires_at: null });
  client.perms = async () => [{ permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'declined' }];
  let r = res(); await ads.connectAccounts(req, r);
  assert.equal(r.code, 200);
  assert.deepEqual(r.data, { connected: 2, permissions: { ads_read: 'granted', ads_management: 'declined', business_management: 'granted', leads_retrieval: 'missing' } });
  assert.deepEqual([client.saved[0].scopes, client.saved[0].declinedScopes], [['ads_read', 'business_management'], ['ads_management']]);
  assert.equal(enqueued.length, 1, 'first sync queued');

  reset();
  client.inspect = async () => ({ is_valid: true, user_id: 'fb1', scopes: ['business_management'], expires_at: null });
  client.perms = async () => [{ permission: 'ads_read', status: 'declined' }];
  r = res(); await ads.connectAccounts(req, r);
  assert.equal(r.code, 400);
  assert.equal(r.data.code, 'ADS_READ_DECLINED');
  assert.equal(r.data.permissions.ads_read, 'declined');
  assert.equal(client.saved.length, 0, 'nothing saved without ad access');

  client.perms = async () => [{ permission: 'business_management', status: 'granted' }];
  r = res(); await ads.connectAccounts(req, r);
  assert.equal(r.data.code, 'ADS_READ_NOT_APPROVED');
  assert.equal(r.data.permissions.ads_read, 'missing');
});

// ── error 190 ──────────────────────────────────────────────────────────────
test('error 190 is recognised in every shape Meta returns it; other errors are not', () => {
  assert.deepEqual(health.deadTokenInfo(dead(460)), { code: 190, subcode: 460, message: 'Error validating access token: The session has been invalidated.' });
  assert.equal(health.deadTokenInfo({ response: { data: { error: { code: 190, error_subcode: 463, message: 'expired' } } } }).subcode, 463);
  assert.equal(health.deadTokenInfo({ code: 190, subcode: 467, message: 'debug_token' }).subcode, 467);
  assert.equal(health.deadTokenInfo(new MetaGraphError({ code: 190 })).subcode, null, 'no subcode is fine');
  assert.equal(health.deadTokenInfo(new MetaGraphError({ code: 200, message: 'permission' })), null);
  assert.equal(health.deadTokenInfo(new Error('ETIMEDOUT')), null);
});

const updatesOf = (re) => calls.filter(c => re.test(c.sql));

test('ad sync: 190 marks the login expired (time + subcode) and returns instead of throwing, so the job is not retried', async () => {
  reset();
  graph = async () => { throw dead(460); };
  const r = await syncAdAccount({ tenantId: 't1', adAccountId: 'a1' });
  assert.deepEqual(r, { skipped: 'token_expired', subcode: 460 });
  const [expire] = updatesOf(/UPDATE ad_oauth_tokens SET status = 'expired'/);
  assert.match(expire.sql, /expired_at = COALESCE\(expired_at, now\(\)\)/, 'first expiry time is kept');
  assert.deepEqual(expire.params.slice(0, 3), ['t1', 'tok1', 460]);
  assert.equal(updatesOf(/UPDATE ad_accounts SET sync_error/).length, 1);

  graph = async () => { throw new MetaGraphError({ code: 2, message: 'Service temporarily unavailable' }, 500); };
  reset();
  await assert.rejects(syncAdAccount({ tenantId: 't1', adAccountId: 'a1' }), /temporarily/, 'other errors still throw (and retry)');
  assert.equal(updatesOf(/UPDATE ad_oauth_tokens/).length, 0);
});

test('posting: 190 marks the Page expired with the subcode; the next post skips Facebook entirely', async () => {
  const post = { id: 'p1', tenant_id: 't1', media: [], caption: 'Hi' };
  const target = { id: 'g1', account_id: 'acc1', platform: 'facebook', status: 'pending', attempts: 0 };
  const run = async (account, publish) => {
    reset((sql) => (/UPDATE social_posts SET status = 'publishing'/.test(sql) ? { rows: [post] } : /FROM social_post_targets t JOIN/.test(sql) ? { rows: [target] } : { rows: [] }));
    const expired = [], marked = [];
    let publishCalls = 0;
    await publishPost({ postId: 'p1' }, {
      query: fakeDb.query, getAccountForPublish: async () => account,
      publishToFacebook: async () => { publishCalls++; return publish(); },
      expireSocialAccount: async ({ query: _q, ...a }) => { expired.push(a); }, markAccount: async (...a) => { marked.push(a); },
      notify: async () => {}, enqueue: async (...a) => { enqueued.push(a); }, signedUrl: async () => 'u',
    });
    const failed = updatesOf(/UPDATE social_post_targets SET status = 'failed'/)[0];
    return { expired, marked, publishCalls, failed };
  };
  const live = { id: 'acc1', platform: 'facebook', status: 'active', token: 'PAGE', external_id: '123' };
  let r = await run(live, async () => { throw dead(460); });
  assert.deepEqual(r.expired, [{ tenantId: 't1', accountId: 'acc1', info: { code: 190, subcode: 460, message: 'Error validating access token: The session has been invalidated.' } }]);
  assert.equal(r.failed.params[3], 3, 'no automatic retry (attempts set to the maximum)');
  assert.equal(enqueued.length, 0);

  r = await run({ ...live, status: 'expired' }, async () => assert.fail('Facebook should not be called'));
  assert.equal(r.publishCalls, 0);
  assert.match(r.failed.params[2], /expired — reconnect/);

  r = await run(live, async () => { throw new MetaGraphError({ code: 200, message: 'Permissions error' }); });
  assert.deepEqual([r.expired.length, r.marked[0]?.[2]], [0, 'error'], 'a missing permission is an error, not an expired login');
});

test('lead fetch: 190 marks the Page login expired and the job returns skipped; later runs stop before calling Facebook', async () => {
  let settings = { meta_page_id: '555', meta_page_access_token: 'PAGE' };
  reset((sql) => {
    if (/FROM tenants WHERE id = \$1/.test(sql)) return { rows: [{ name: 'Glow', settings }] };
    if (/settings->>'meta_page_id' = \$1/.test(sql) || /meta_page_id/.test(sql) && /SELECT id FROM tenants/.test(sql)) return { rows: [{ id: 't1' }] };
    return { rows: [] };
  });
  graph = async () => { throw dead(463); };
  const r = await metaLeads.ingestWebhookLead({ pageId: '555', leadgenId: '999' });
  assert.deepEqual(r, { skipped: 'token_expired' });
  const [mark] = updatesOf(/meta_page_token_status/);
  assert.deepEqual(mark.params.slice(0, 2), ['t1', 463]);

  settings = { ...settings, meta_page_token_status: 'expired' };
  let called = false;
  graph = async () => { called = true; return {}; };
  assert.deepEqual(await metaLeads.ingestWebhookLead({ pageId: '555', leadgenId: '1000' }), { skipped: 'token_expired' });
  assert.deepEqual(await metaLeads.pollRecentLeads('t1'), { created: 0, duplicate: 0, skipped: 0, token_expired: true });
  assert.equal(called, false);
});

test('queues never retry an error flagged noRetry (in-process mode)', async () => {
  const p = require.resolve('../jobs/queues');
  const saved = require.cache[p];
  delete require.cache[p];
  const queues = require('../jobs/queues');
  let runs = 0;
  queues.register('test:no-retry', async () => { runs++; throw Object.assign(new Error('login ended'), { noRetry: true }); }, { attempts: 5, backoffMs: 1 });
  queues.register('test:retry', async () => { runs++; throw new Error('flaky'); }, { attempts: 3, backoffMs: 1 });
  const origError = console.error; console.error = () => {};
  const settle = async (n) => { for (let i = 0; i < 100 && runs < n; i++) await new Promise(r => setTimeout(r, 10)); await new Promise(r => setTimeout(r, 60)); };
  try {
    await queues.enqueue('test:no-retry');
    await settle(1);
    assert.equal(runs, 1, 'ran once, no retries');
    runs = 0;
    await queues.enqueue('test:retry');
    await settle(3);
    assert.equal(runs, 3, 'ordinary errors still retry');
  } finally { console.error = origError; require.cache[p] = saved; }
});

test('token check script: dry run reports and changes nothing; invalid logins carry their subcode', async () => {
  assert.deepEqual(verdict({ is_valid: true }), { valid: true, action: 'ok' });
  assert.deepEqual(verdict({ is_valid: false, error: { code: 190, subcode: 460, message: 'password changed' } }),
    { valid: false, action: 'mark expired', subcode: 460, reason: 'password changed' });
  const { encryptToken } = require('../utils/cryptoSecrets');
  const enc = encryptToken('USER-TOKEN');
  const writes = [];
  const db = { query: async (sql) => {
    if (/^UPDATE/.test(sql.trim())) { writes.push(sql); return { rows: [] }; }
    if (/FROM ad_oauth_tokens/.test(sql)) return { rows: [{ id: 'o1', tenant_id: 't1', workspace: 'Glow', status: 'active', token_encrypted: enc.ciphertext, key_version: enc.keyVersion }] };
    if (/FROM social_accounts/.test(sql)) return { rows: [] };
    return { rows: [{ id: 't2', workspace: 'Lakme', page: 'Lakme Page', token: 'PAGE-TOKEN' }] };
  } };
  const lines = [];
  const inspect = async (token) => (token === 'USER-TOKEN' ? { is_valid: false, error: { code: 190, subcode: 460, message: 'password changed' } } : { is_valid: true });
  const out = await checkTokens(db, { inspect, log: (l) => lines.push(l) });
  assert.deepEqual(out.summary, { checked: 2, valid: 1, invalid: 1, check_failed: 0, mode: 'dry-run' });
  assert.equal(out.results[0].action, 'would mark expired');
  assert.equal(writes.length, 0, 'dry run writes nothing');
  assert.ok(lines.every(l => !/USER-TOKEN|PAGE-TOKEN/.test(l)), 'tokens are never printed');
  await checkTokens(db, { inspect, apply: true, log: () => {} });
  assert.equal(writes.length, 1, '--apply marks the invalid one');
});
