// Phase 1 ad identity: key derivation, explicit rollout modes, writers and readers in every mode, migration files.
// Backfill: tests/adIdentityBackfill.test.js. Readiness + rollout: tests/adIdentityReadiness.test.js.
// Real-PostgreSQL behavior lives in tests/adIdentitySql.test.js (skipped without ADS_TEST_DATABASE_URL).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ai = require('../services/adIdentity');
const F = require('./helpers/adIdentityFakes');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const stripSqlComments = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

// ---- key derivation -------------------------------------------------------------------------
test('Meta ids are their own key; Google campaign and ad group ids too', () => {
  assert.equal(ai.adEntityKey('meta', 'ad', { id: 120001 }), '120001');
  assert.equal(ai.adEntityKey('meta', 'campaign', { id: '55' }), '55');
  assert.equal(ai.adEntityKey('google', 'campaign', { id: '77' }), '77');
  assert.equal(ai.adEntityKey('google', 'adset', { id: '88' }), '88');
});

test('a Google ad key includes its ad group, so the same ad id in two ad groups differs', () => {
  const a = ai.adEntityKey('google', 'ad', { id: '999', adGroupId: '10' });
  const b = ai.adEntityKey('google', 'ad', { id: '999', adGroupId: '11' });
  assert.equal(a, '10~999');
  assert.equal(b, '11~999');
  assert.notEqual(a, b);
});

test('a Google ad without its ad group gets no key instead of the colliding bare id', () => {
  assert.equal(ai.adEntityKey('google', 'ad', { id: '999' }), null);
  assert.equal(ai.adEntityKey('google', 'ad', { id: '999', adGroupId: '' }), null);
  assert.equal(ai.adEntityKey('google', 'ad', { id: '999', adGroupId: '   ' }), null);
  assert.equal(ai.adEntityKey('meta', 'ad', {}), null);
});

test('a Meta ad and a Google ad with the same numeric id never share a key', () => {
  assert.notEqual(ai.adEntityKey('meta', 'ad', { id: '4242' }), ai.adEntityKey('google', 'ad', { id: '4242', adGroupId: '1' }));
});

// ---- the explicit rollout: columns alone never switch anything ---------------------------------------
const modeOf = async (spec) => { ai.resetIdentityModeCache(); return ai.getIdentityMode(F.structureDb(spec), { force: true }); };

test('new columns alone never activate any new mode', async () => {
  // Everything migrated (columns, valid scoped indexes, validated constraints) but nobody set a rollout state.
  assert.equal(await modeOf({ rolloutPresent: false, state: null, indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() }), 'legacy');
  assert.equal(await modeOf({ rolloutPresent: true, state: null, indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() }), 'legacy');
  assert.equal(await modeOf({ state: 'legacy', indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() }), 'legacy');
  assert.equal(await modeOf({ rolloutPresent: false, state: null, columns: F.allColumns() }), 'legacy', 'columns without a rollout table');
});

test('an unknown rollout state is treated as legacy', async () => {
  assert.equal(await modeOf({ state: 'turbo' }), 'legacy');
});

test('partial migration: dual_write needs every column; scoped needs the whole structure', async () => {
  const partial = F.allColumns().slice(1); // one column missing
  assert.equal(await modeOf({ state: 'dual_write', columns: partial }), 'legacy', 'dual_write with a column missing cannot write the keys');
  assert.equal(await modeOf({ state: 'scoped', columns: partial, indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() }), 'legacy');
  assert.equal(await modeOf({ state: 'dual_write' }), 'dual_write');
  const full = { state: 'scoped', indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() };
  assert.equal(await modeOf(full), 'scoped');
});

test('a scoped rollout degrades to dual_write when an index or constraint is not usable', async () => {
  const base = { state: 'scoped' };
  const withIdx = (mut) => [...F.legacyIndexes(), ...F.scopedIndexes().map(mut)];
  assert.equal(await modeOf({ ...base, indexes: F.legacyIndexes(), constraints: F.keyConstraints() }), 'dual_write', 'indexes missing');
  assert.equal(await modeOf({ ...base, indexes: withIdx((i, n) => (n === 0 ? { ...i, indisvalid: false } : i)), constraints: F.keyConstraints() }), 'dual_write', 'INVALID index from a failed CONCURRENTLY build');
  assert.equal(await modeOf({ ...base, indexes: withIdx((i, n) => (n === 1 ? { ...i, indisready: false } : i)), constraints: F.keyConstraints() }), 'dual_write', 'index not ready');
  assert.equal(await modeOf({ ...base, indexes: withIdx((i, n) => (n === 2 ? { ...i, predicate: '(external_key IS NOT NULL)' } : i)), constraints: F.keyConstraints() }), 'dual_write', 'partial index cannot enforce uniqueness');
  assert.equal(await modeOf({ ...base, indexes: withIdx((i, n) => (n === 3 ? { ...i, definition: i.definition.replace('ad_account_id, ', '') } : i)), constraints: F.keyConstraints() }), 'dual_write', 'an index with the wrong columns is not the scoped key');
  assert.equal(await modeOf({ ...base, indexes: withIdx((i) => i), constraints: [] }), 'dual_write', 'key-present constraints missing');
  assert.equal(await modeOf({ ...base, indexes: withIdx((i) => i), constraints: F.keyConstraints({ convalidated: false }) }), 'dual_write', 'NOT VALID constraints');
});

test('a failing probe falls back to legacy and the result is cached for the TTL', async () => {
  ai.resetIdentityModeCache();
  const bad = F.structureDb({ fail: true });
  assert.equal(await ai.getIdentityMode(bad), 'legacy');
  let calls = 0; const counting = { query: async (...a) => { calls++; return bad.query(...a); } };
  ai.resetIdentityModeCache();
  await ai.getIdentityMode(counting); const first = calls;
  await ai.getIdentityMode(counting);
  assert.equal(calls, first, 'second call served from cache');
});

test('in the default legacy state the probe is a single trivial query, not a catalog scan', async () => {
  ai.resetIdentityModeCache();
  const sqls = []; const db = F.structureDb({ rolloutPresent: false, state: null });
  await ai.getIdentityMode({ query: async (sql, p) => { sqls.push(sql); return db.query(sql, p); } }, { force: true });
  assert.deepEqual(sqls.map((s) => /to_regclass/.test(s)), [true]);
});

test('probe SQL requires indexes valid, ready and unique, and never targets a missing table directly', () => {
  const src = read('services/adIdentity.js');
  assert.match(src, /i\.indisvalid/);
  assert.match(src, /i\.indisready/);
  assert.match(src, /i\.indisunique/);
  assert.match(src, /to_regclass/, 'the rollout table is checked with to_regclass so a missing table cannot raise');
});

test('conflict targets are legacy in every mode except scoped; dual_write only adds columns', () => {
  for (const m of ['legacy', 'dual_write']) {
    assert.equal(ai.conflictTarget(m, 'ad_ads'), '(tenant_id, external_id)', m);
    assert.equal(ai.conflictTarget(m, 'ad_insights_daily'), '(tenant_id, entity_type, entity_id, date)', m);
    assert.doesNotMatch(ai.insightsJoinOn(m, 'i', 'ad'), /ad_account_id|entity_key/, m);
  }
  assert.equal(ai.conflictTarget('scoped', 'ad_ads'), '(tenant_id, ad_account_id, external_key)');
  assert.equal(ai.conflictTarget('scoped', 'ad_insights_daily'), '(tenant_id, ad_account_id, entity_type, entity_key, date)');
  assert.match(ai.insightsJoinOn('scoped', 'i', 'ad'), /i\.ad_account_id = ad\.ad_account_id AND i\.entity_key = ad\.external_key/);
  assert.equal(ai.dualWriteSet('legacy', 'ad_ads'), '');
  assert.match(ai.dualWriteSet('dual_write', 'ad_ads'), /external_key = EXCLUDED\.external_key/);
});

test('legacy-mode joins are exactly the pre-migration SQL', () => {
  assert.equal(ai.entityJoinOn('legacy', 'i', 'c', 'campaign'), `i.tenant_id = c.tenant_id AND i.entity_id = c.external_id AND i.entity_type = 'campaign'`);
});

// ---- writers, in every mode ------------------------------------------------------------------
const loadFresh = (files, db) => {
  const dbPath = require.resolve('../config/db');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  for (const f of files) delete require.cache[require.resolve(f)];
  try { return files.map((f) => require(f)); }
  finally { if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath]; for (const f of files) delete require.cache[require.resolve(f)]; }
};
const withWarnings = async (fn) => { const w = []; const orig = console.warn; console.warn = (...a) => w.push(a.join(' ')); try { await fn(); } finally { console.warn = orig; } return w; };
const adWrites = (db, table) => db.log.filter((c) => new RegExp(`INSERT INTO ${table}\\b`).test(c.sql));

const googleInput = () => ({
  tenantId: 't1', adAccountId: 'acct-g',
  campaigns: [{ external_id: '5', name: 'C', effective_status: 'ACTIVE' }],
  adGroups: [{ external_id: '10', campaign_external_id: '5', name: 'G10' }, { external_id: '11', campaign_external_id: '5', name: 'G11' }],
  ads: [{ external_id: '999', adset_external_id: '10', name: 'a', creative: {} }, { external_id: '999', adset_external_id: '11', name: 'b', creative: {} }],
});

for (const mode of ['legacy', 'dual_write', 'scoped']) {
  test(`Google hierarchy in ${mode} mode: right columns, right conflict target, legacy constraint never bypassed`, async () => {
    ai.resetIdentityModeCache();
    const db = F.modeDb(mode);
    const [sync] = loadFresh(['../services/googleAds/sync'], db);
    await sync.saveHierarchy(googleInput());
    const writes = db.log.filter((c) => /INSERT INTO ad_(campaigns|adsets|ads)\b/.test(c.sql));
    assert.equal(writes.length, 5, 'campaign, two ad groups and both ads are written (none skipped)');
    assert.deepEqual(db.probesInTxn, [], 'the mode probe never runs inside the transaction');
    for (const c of writes) {
      assert.doesNotMatch(c.sql, /ON CONFLICT DO NOTHING|DROP|ALTER/i);
      if (mode === 'scoped') assert.match(c.sql, /ON CONFLICT \(tenant_id, ad_account_id, external_key\)/);
      else assert.match(c.sql, /ON CONFLICT \(tenant_id, external_id\)/, 'legacy unique key remains the arbiter');
      if (mode === 'legacy') assert.doesNotMatch(c.sql, /external_key|provider/);
      else { assert.match(c.sql, /external_key/); assert.match(c.sql, /'google'/); }
      if (mode === 'dual_write') assert.match(c.sql, /external_key = EXCLUDED\.external_key/, 'denormalized keys follow a legacy-keyed upsert');
    }
    const ads = adWrites(db, 'ad_ads');
    if (mode === 'legacy') assert.ok(ads.every((c) => !c.params.includes('10~999')));
    else {
      assert.deepEqual(ads.map((c) => c.params[c.params.length - 1]), ['10~999', '11~999']);
      assert.ok(ads.every((c) => c.params.includes('acct-g')));
    }
  });
}

test('a Google ad whose ad group id is blank is never stored with a NULL or guessed key once keys are written', async () => {
  const input = () => ({ ...googleInput(), adGroups: [{ external_id: ' ', campaign_external_id: '5', name: 'blank' }], ads: [{ external_id: '999', adset_external_id: ' ', name: 'x', creative: {} }] });
  for (const mode of ['dual_write', 'scoped']) {
    ai.resetIdentityModeCache();
    const db = F.modeDb(mode);
    const [sync] = loadFresh(['../services/googleAds/sync'], db);
    const warnings = await withWarnings(() => sync.saveHierarchy(input()));
    assert.equal(adWrites(db, 'ad_ads').length, 0, mode);
    assert.ok(warnings.some((w) => /1 ad\(s\) had no ad group id and were not stored/.test(w)), `${mode}: skipped, not silent`);
  }
  ai.resetIdentityModeCache();
  const db = F.modeDb('legacy');
  const [sync] = loadFresh(['../services/googleAds/sync'], db);
  await sync.saveHierarchy(input());
  assert.equal(adWrites(db, 'ad_ads').length, 1, 'legacy behaviour is unchanged');
});

test('Google daily rows: keyed per level; unkeyable ad rows are dropped and logged only once keys are written', async () => {
  const rows = () => ({ campaign: [{ entity_id: '5', date: '2026-10-01', spend: 1 }], adset: [], ad: [
    { entity_id: '999', adset_external_id: '10', date: '2026-10-01', spend: 1 }, { entity_id: '998', adset_external_id: null, date: '2026-10-01', spend: 2 }] });
  const args = () => ({ tenantId: 't1', adAccountId: 'acct-g', externalAccountId: '123', since: '2026-10-01', until: '2026-10-01', rows: rows() });
  const sent = async (mode) => {
    ai.resetIdentityModeCache();
    const db = F.modeDb(mode);
    const [sync] = loadFresh(['../services/googleAds/sync'], db);
    let saved; const warnings = await withWarnings(async () => { saved = await sync.saveDailyMetrics(args()); });
    const adInsert = db.log.find((c) => /INSERT INTO ad_insights_daily/.test(c.sql) && c.params[2] === 'ad');
    return { saved, warnings, db, payload: JSON.parse(adInsert.params[3]), sql: adInsert.sql };
  };
  const legacy = await sent('legacy');
  assert.equal(legacy.payload.length, 2); assert.equal(legacy.saved, 3);
  assert.doesNotMatch(legacy.sql, /entity_key,/);
  for (const mode of ['dual_write', 'scoped']) {
    const r = await sent(mode);
    assert.deepEqual(r.payload.map((x) => x.entity_key), ['10~999'], mode);
    assert.equal(r.saved, 2, `${mode}: the unkeyable row is not counted as saved`);
    assert.ok(r.warnings.some((w) => /1 row\(s\) had no ad group id/.test(w)), mode);
    assert.match(r.sql, mode === 'scoped' ? /ON CONFLICT \(tenant_id, ad_account_id, entity_type, entity_key, date\)/ : /ON CONFLICT \(tenant_id, entity_type, entity_id, date\)/);
    assert.deepEqual(r.db.probesInTxn, []);
  }
});

for (const mode of ['legacy', 'dual_write', 'scoped']) {
  test(`Meta hierarchy in ${mode} mode`, async () => {
    ai.resetIdentityModeCache();
    const db = F.modeDb(mode);
    const [meta] = loadFresh(['../services/metaAds/hierarchy', '../utils/metaCampaignMatch'], db);
    await meta.saveHierarchy({ tenantId: 't1', adAccountId: 'acct-A', campaigns: [{ id: '777', name: 'X', adsets: [{ id: '8', ads: [{ id: '9' }] }] }] });
    const w = db.log.filter((c) => /INSERT INTO ad_(campaigns|adsets|ads)\b/.test(c.sql));
    assert.equal(w.length, 3);
    assert.deepEqual(db.probesInTxn, []);
    for (const c of w) {
      if (mode === 'scoped') assert.match(c.sql, /ON CONFLICT \(tenant_id, ad_account_id, external_key\)/);
      else assert.match(c.sql, /ON CONFLICT \(tenant_id, external_id\)/);
      if (mode === 'legacy') assert.doesNotMatch(c.sql, /external_key|provider/);
      else { assert.match(c.sql, /'meta'/); assert.match(c.sql, /external_key = EXCLUDED\.external_key/); }
    }
    if (mode !== 'legacy') for (const c of w.filter((x) => /INSERT INTO ad_(adsets|ads)\b/.test(x.sql))) assert.ok(c.params.includes('acct-A'));
  });
}

test('Meta daily insights: ad rows and every rollup level carry the key in dual_write/scoped, none in legacy', async () => {
  const row = { ad_id: '9', adset_id: '8', campaign_id: '7', date_start: '2026-10-01', spend: '10', impressions: '100', clicks: '5' };
  for (const mode of ['legacy', 'dual_write', 'scoped']) {
    ai.resetIdentityModeCache();
    const db = F.modeDb(mode);
    const [ins] = loadFresh(['../services/metaAds/insights'], db);
    await ins.saveDailyInsights({ tenantId: 't1', adAccountId: 'acct-A', externalAccountId: 'act_1', since: '2026-10-01', until: '2026-10-01', rows: [row] });
    const inserts = db.log.filter((c) => /INSERT INTO ad_insights_daily/.test(c.sql));
    assert.equal(inserts.length, 4, `${mode}: ad + adset + campaign + account`);
    for (const c of inserts) {
      if (mode === 'legacy') assert.doesNotMatch(c.sql, /entity_key/);
      else assert.match(c.sql, /entity_key, provider/);
      assert.match(c.sql, mode === 'scoped' ? /ON CONFLICT \(tenant_id, ad_account_id, entity_type, entity_key, date\)/ : /ON CONFLICT \(tenant_id, entity_type, entity_id, date\)/);
    }
    assert.deepEqual(db.probesInTxn, []);
  }
});

test('writers never hard-code a legacy ON CONFLICT target for ad tables and never drop a legacy constraint', () => {
  for (const f of ['services/googleAds/sync.js', 'services/metaAds/hierarchy.js', 'services/metaAds/insights.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /ON CONFLICT \(tenant_id, external_id\)/, f);
    assert.doesNotMatch(src, /ON CONFLICT \(tenant_id, entity_type, entity_id, date\)/, f);
    assert.doesNotMatch(src, /ON CONFLICT DO NOTHING|DROP CONSTRAINT|DROP INDEX/i, f);
    assert.match(src, /conflictTarget\(mode/, f);
    assert.match(src, /getIdentityMode\(\{ query \}\)/, `${f}: probe on the pool`);
    assert.doesNotMatch(src, /getIdentityMode\(client\)/, `${f}: never probe inside a transaction`);
  }
});

// ---- readers, in every mode ---------------------------------------------------------------------
function loadVm(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(read(file), { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, Intl, process: { env: {} }, setTimeout, require: (k) => deps[k] || {} });
  return module.exports;
}
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const readerDb = (mode) => {
  const st = F.structureDb(F.MODE_SPECS[mode]()); const seen = [];
  return { seen, query: async (sql, params) => { const p = st.answer(sql); if (p) return p; seen.push({ sql, params }); return { rows: [{ id: '00000000-0000-0000-0000-000000000001' }] }; } };
};
const norm = (s) => s.replace(/\s+/g, ' ');

for (const mode of ['legacy', 'dual_write', 'scoped']) {
  test(`Ads Manager readers in ${mode} mode`, async () => {
    ai.resetIdentityModeCache();
    const db = readerDb(mode);
    const ctrl = loadVm('controllers/adsController.js', { '../config/db': db, '../services/adIdentity': ai });
    const id = '00000000-0000-0000-0000-000000000001';
    await ctrl.listCampaigns({ tenantId: 't', query: {} }, res());
    await ctrl.listAdsets({ tenantId: 't', params: { id }, query: {} }, res());
    await ctrl.listAds({ tenantId: 't', params: { id }, query: {} }, res());
    const joins = db.seen.map((c) => norm(c.sql)).filter((s) => /LEFT JOIN ad_insights_daily i ON/.test(s)).map((s) => /LEFT JOIN ad_insights_daily i ON (.*?) AND i\.date/.exec(s)[1]);
    assert.equal(joins.length, 3, `${mode}: campaign, ad set and ad lists were exercised`);
    for (const j of joins) {
      if (mode === 'scoped') assert.match(j, /\.ad_account_id = \w+\.ad_account_id AND i\.entity_key = \w+\.external_key/, j);
      else {
        assert.doesNotMatch(j, /ad_account_id|entity_key|external_key/, `${mode}: legacy SQL unchanged: ${j}`);
        assert.match(j, /^i\.tenant_id = (\w+)\.tenant_id AND i\.entity_id = \1\.external_id AND i\.entity_type = '\w+'$/, j);
      }
    }
    const adSelect = db.seen.map((c) => norm(c.sql)).find((s) => /FROM ad_ads a\b/.test(s));
    assert.equal(/a\.external_key AS entity_key/.test(adSelect), mode === 'scoped', `${mode}: entity_key column only where keys are authoritative`);
  });
}

test('daily insights: scoped addresses the canonical key; legacy resolves "<adGroup>~<ad>" without ambiguity; bad input is rejected', async () => {
  const call = async (mode, q) => {
    ai.resetIdentityModeCache();
    const db = readerDb(mode); const ctrl = loadVm('controllers/adsController.js', { '../config/db': db, '../services/adIdentity': ai });
    const r = res(); await ctrl.dailyInsights({ tenantId: 't', query: { entity_type: 'ad', ...q } }, r);
    return { r, q: db.seen[0] };
  };
  let o = await call('scoped', { entity_id: '10~999' });
  assert.match(o.q.sql, /entity_key = \$3/); assert.equal(o.q.params[2], '10~999');
  o = await call('legacy', { entity_id: '10~999' });
  assert.match(norm(o.q.sql), /entity_id = \$3 AND \(\$7::text IS NULL OR adset_external_id = \$7::text\)/);
  assert.equal(o.q.params[2], '999'); assert.equal(o.q.params[6], '10');
  o = await call('legacy', { entity_id: '999' });
  assert.equal(o.q.params[2], '999'); assert.equal(o.q.params[6], null, 'a bare id behaves as before');
  assert.equal((await call('scoped', { entity_id: '10~999~1' })).r.code, 422);
  assert.equal((await call('scoped', { entity_id: '999', entity_type: 'campaign' })).r.code, 200);
  const campaignWithKey = res();
  ai.resetIdentityModeCache();
  await loadVm('controllers/adsController.js', { '../config/db': readerDb('legacy'), '../services/adIdentity': ai }).dailyInsights({ tenantId: 't', query: { entity_type: 'campaign', entity_id: '1~2' } }, campaignWithKey);
  assert.equal(campaignWithKey.code, 422, 'a composite key is only valid for ads');
});

test('every reader that joins insights to hierarchy goes through the mode-aware join', () => {
  for (const f of ['controllers/adsController.js', 'controllers/campaignController.js', 'services/googleAds/aiSearch.js', 'services/metaAds/aiCampaign.js', 'services/metrics.js']) {
    const src = read(f);
    assert.match(src, /getIdentityMode/, f);
    assert.match(src, /entityJoinOn|insightsJoinOn/, f);
    assert.doesNotMatch(src, /i\.ad_account_id = (ac|c)\.ad_account_id AND i\.date/, `${f}: no unconditional account join (it would change legacy SQL)`);
  }
});

test('Meta ad lookup by id is restricted to Meta accounts', () => {
  assert.match(read('utils/metaCampaignMatch.js'), /acc\.provider = 'meta'/);
});

// ---- migration files ------------------------------------------------------------------------
test('columns migration is additive: nullable ADD COLUMN only, no constraint, index or data change', () => {
  const sql = stripSqlComments(read('models/migration_ad_identity_columns.sql'));
  assert.doesNotMatch(sql, /\b(NOT NULL|DROP|UPDATE|DELETE|INSERT|CREATE\s+(UNIQUE\s+)?INDEX|PRIMARY KEY|UNIQUE)\b/i);
  for (const [t, c] of ai.REQUIRED_COLUMNS) {
    const block = sql.match(new RegExp(`ALTER TABLE ${t}\\b[^;]*;`, 'i'));
    assert.ok(block && new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`).test(block[0]), `${t}.${c}`);
  }
});

test('rollout migration creates one inert control table: default legacy, constrained states, no data, no other table touched', () => {
  const sql = stripSqlComments(read('models/migration_ad_identity_rollout.sql'));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ad_identity_rollout/);
  assert.match(sql, /CHECK \(id = 1\)/);
  assert.match(sql, /state\s+varchar\(20\) NOT NULL DEFAULT 'legacy'/);
  assert.match(sql, /CHECK \(state IN \('legacy', 'dual_write', 'scoped'\)\)/);
  assert.doesNotMatch(sql, /\b(ALTER|UPDATE|DELETE|INSERT|DROP)\b/i, 'creating the table activates nothing and seeds no row');
  assert.equal(ai.ROLLOUT_TABLE, 'ad_identity_rollout');
});

test('step 5 builds exactly the indexes and constraints the guard looks for, concurrently, on the agreed columns', () => {
  const sql = stripSqlComments(read('db/phase1/ad_identity/03_constraints_and_indexes.sql'));
  for (const [name, spec] of Object.entries(ai.SCOPED_INDEX_SPECS)) {
    assert.match(sql, new RegExp(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${name}\\s+ON ${spec.table}\\s+\\(${spec.columns.join(', ')}\\)`), name);
  }
  for (const [name, table] of Object.entries(ai.KEY_PRESENT_CONSTRAINTS)) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\s+ADD CONSTRAINT ${name}\\s+CHECK .* NOT VALID`), name);
    assert.match(sql, new RegExp(`ALTER TABLE ${table}\\s+VALIDATE CONSTRAINT ${name}`), name);
  }
  assert.doesNotMatch(sql, /\b(BEGIN|START TRANSACTION)\b/i, 'CONCURRENTLY cannot run in a transaction');
  assert.doesNotMatch(sql, /DROP CONSTRAINT|DROP INDEX|PRIMARY KEY/i, 'legacy keys stay until the separate key swap');
});

test('no file other than rollbacks and the key-swap placeholder can remove a key, and no script references the key swap', () => {
  const dir = path.join(__dirname, '..', 'db', 'phase1', 'ad_identity');
  const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), path.join(__dirname, '..', 'models', 'migration_ad_identity_columns.sql'), path.join(__dirname, '..', 'models', 'migration_ad_identity_rollout.sql')];
  for (const f of files.filter((x) => x.endsWith('.sql') && !/99_key_swap|rollback_/.test(x))) {
    assert.doesNotMatch(stripSqlComments(fs.readFileSync(f, 'utf8')), /DROP\s+(CONSTRAINT|INDEX|TABLE)/i, path.basename(f));
  }
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'scripts')).filter((x) => /adIdentity|backfillAdIdentity/.test(x))) {
    assert.doesNotMatch(read(`scripts/${f}`), /99_key_swap/, f);
  }
});

test('rollbacks undo exactly what the forward files add', () => {
  const idx = read('db/phase1/ad_identity/rollback_03_indexes.sql');
  for (const name of ai.SCOPED_INDEXES) assert.match(idx, new RegExp(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`));
  for (const name of Object.keys(ai.KEY_PRESENT_CONSTRAINTS)) assert.match(idx, new RegExp(`DROP CONSTRAINT IF EXISTS ${name}`));
  const cols = read('db/phase1/ad_identity/rollback_01_columns.sql');
  for (const [t, c] of ai.REQUIRED_COLUMNS) assert.match(cols.match(new RegExp(`ALTER TABLE ${t}\\b[^;]*;`))[0], new RegExp(`DROP COLUMN IF EXISTS ${c}\\b`));
});

test('the key swap file refuses to run without explicit confirmation and holds no live statement', () => {
  const raw = read('db/phase1/ad_identity/99_key_swap_DO_NOT_RUN.sql');
  assert.match(raw, /\\quit/);
  assert.match(raw, /confirm_key_swap/);
  const live = raw.split('\n').filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('\\')).join('\n');
  assert.doesNotMatch(live, /\b(ALTER|DROP|CREATE|UPDATE|DELETE|INSERT|BEGIN|COMMIT)\b/i, 'no executable SQL until a human fills it in');
});

// ---- migration checker (the pending warning) ----------------------------------------------------------
test('the migration checker flags the new files as pending only because their objects are absent; it never writes', () => {
  const { expectedObjects } = require('../scripts/checkMigrations');
  const cols = expectedObjects(read('models/migration_ad_identity_columns.sql'));
  assert.ok(cols.columns.some(([t, c]) => t === 'ad_ads' && c === 'external_key'));
  const roll = expectedObjects(read('models/migration_ad_identity_rollout.sql'));
  assert.deepEqual(roll.tables, ['ad_identity_rollout']);
  const body = read('scripts/checkMigrations.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(body, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|INDEX))\b/i, 'the checker only reads the catalog');
});

// ---- diagnostics script ---------------------------------------------------------------------------------
test('every diagnostic is a read-only SELECT and the runner opens a READ ONLY transaction', async () => {
  const d = require('../scripts/adIdentityDiagnostics');
  const stmts = d.parseStatements(fs.readFileSync(d.SQL_FILE, 'utf8'));
  assert.ok(stmts.length >= 8);
  const seen = [];
  const client = { query: async (sql) => { seen.push(sql); return { rows: [] }; } };
  await d.run({ client, statements: stmts });
  assert.equal(seen[0], 'BEGIN READ ONLY');
  assert.equal(seen[seen.length - 1], 'ROLLBACK');
  assert.ok(!seen.some((s) => /\b(UPDATE|INSERT|DELETE|DROP|ALTER|CREATE)\b/i.test(s)));
});

test('the diagnostics parser rejects anything that is not a SELECT', () => {
  const d = require('../scripts/adIdentityDiagnostics');
  assert.throws(() => d.parseStatements('-- @@ x\nDELETE FROM ad_ads'), /not a SELECT/);
  assert.throws(() => d.parseStatements('-- @@ x\nSELECT 1; DROP TABLE a'), /write keyword/);
});

test('every script refuses to run without explicit authorization and its own dedicated URL', () => {
  const { spawnSync } = require('child_process');
  const urls = ['AD_IDENTITY_DIAGNOSTICS_URL', 'AD_IDENTITY_BACKFILL_URL', 'AD_IDENTITY_READINESS_URL', 'AD_IDENTITY_ROLLOUT_URL'];
  for (const s of ['adIdentityDiagnostics.js', 'backfillAdIdentity.js', 'adIdentityReadiness.js', 'adIdentityRollout.js']) {
    const env = { ...process.env, DATABASE_URL: 'postgres://nope', DB_HOST: 'nope' };
    for (const u of urls) delete env[u];
    const extra = s === 'adIdentityRollout.js' ? ['status'] : [];
    let r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', s), ...extra], { env, encoding: 'utf8' });
    assert.equal(r.status, 2, s); assert.match(r.stderr, /Refusing/);
    r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', s), ...extra, '--i-have-authorization'], { env, encoding: 'utf8' });
    assert.equal(r.status, 2, s); assert.match(r.stderr, /Refusing: set AD_IDENTITY_/);
  }
});
