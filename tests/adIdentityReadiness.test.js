// Readiness gate (read-only PASS/FAIL with reasons and counts) and the rollout transitions, including rollback.
// No database: catalog and rollout state are in-memory fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../services/adIdentity');
const F = require('./helpers/adIdentityFakes');
const readiness = require('../scripts/adIdentityReadiness');
const rollout = require('../scripts/adIdentityRollout');

const zero = () => ({ null_keys: 0, unresolvable: 0, wrong_keys: 0, malformed_keys: 0, scoped_duplicates: 0 });
const goodFacts = (over = {}) => ({
  rollout: { present: true, state: 'dual_write', age_seconds: 3600 },
  missing_columns: [],
  indexes: [...F.legacyIndexes(), ...F.scopedIndexes()],
  constraints: F.keyConstraints(),
  counts: {
    by_table: { ad_campaigns: zero(), ad_adsets: zero(), ad_ads: zero(), ad_insights_daily: zero() },
    unresolvable_reasons: {}, samples: [], warnings: { insights_currency_null: 0, ad_insight_rows_without_ad_row: 0 },
  },
  ...over,
});
const withTable = (table, patch) => { const f = goodFacts(); Object.assign(f.counts.by_table[table], patch); return f; };
const failing = (facts) => readiness.evaluateReadiness(facts).failing;
const checkOf = (report, name) => report.checks.find((c) => c.name === name);

// ---- evaluateReadiness -------------------------------------------------------------------------------------
test('a fully prepared database passes', () => {
  const r = readiness.evaluateReadiness(goodFacts());
  assert.equal(r.status, 'PASS');
  assert.deepEqual(r.failing, []);
  assert.ok(r.checks.every((c) => c.status === 'PASS' && typeof c.reason === 'string' && c.reason.length));
});

test('partial migration fails with the missing columns named and the data checks marked not evaluable', () => {
  const r = readiness.evaluateReadiness(goodFacts({ missing_columns: ['ad_ads.external_key', 'ad_ads.provider'], counts: null }));
  assert.equal(r.status, 'FAIL');
  const c = checkOf(r, 'columns_present');
  assert.equal(c.count, 2); assert.match(c.reason, /migration incomplete: 2 column\(s\) missing: ad_ads\.external_key, ad_ads\.provider/);
  for (const n of ['backfill_complete', 'unresolvable_records', 'canonical_keys_valid', 'no_scoped_duplicates']) assert.match(checkOf(r, n).reason, /cannot be evaluated/);
});

test('the rollout must be explicit: missing table, legacy state, or a state set too recently all fail', () => {
  let r = readiness.evaluateReadiness(goodFacts({ rollout: { present: false, state: null, age_seconds: null } }));
  assert.match(checkOf(r, 'rollout_state').reason, /does not exist/);
  r = readiness.evaluateReadiness(goodFacts({ rollout: { present: true, state: 'legacy', age_seconds: 99999 } }));
  assert.match(checkOf(r, 'rollout_state').reason, /rollout state is 'legacy'; set 'dual_write' first/);
  r = readiness.evaluateReadiness(goodFacts({ rollout: { present: true, state: 'dual_write', age_seconds: 60 } }));
  assert.deepEqual(r.failing, ['dual_write_soak']);
  assert.match(checkOf(r, 'dual_write_soak').reason, /wait at least 900s/);
  assert.equal(readiness.evaluateReadiness(goodFacts({ rollout: { present: true, state: 'scoped', age_seconds: 5 } })).status, 'PASS', 'the soak only applies while moving out of dual_write');
});

test('incomplete backfill: rows that can be keyed but have no key fail with counts per table', () => {
  const r = readiness.evaluateReadiness(withTable('ad_ads', { null_keys: 12, unresolvable: 4 }));
  const c = checkOf(r, 'backfill_complete');
  assert.equal(c.status, 'FAIL'); assert.equal(c.count, 8);
  assert.match(c.reason, /8 record\(s\) still lack a key but can be keyed \(ad_ads=8\)/);
  assert.deepEqual(r.failing.sort(), ['backfill_complete', 'unresolvable_records']);
});

test('unresolvable records (Google ads without an ad group id) fail separately, with reasons and samples, and nothing is guessed', () => {
  const f = withTable('ad_insights_daily', { null_keys: 3, unresolvable: 3 });
  f.counts.unresolvable_reasons = { 'ad_insights_daily.google_ad_missing_ad_group_id': 3 };
  f.counts.samples = [{ ad_account_id: 'a', ad_id: '555', rows: 3 }];
  const r = readiness.evaluateReadiness(f);
  assert.equal(checkOf(r, 'backfill_complete').status, 'PASS', 'there is nothing left that the backfill could do');
  const c = checkOf(r, 'unresolvable_records');
  assert.equal(c.status, 'FAIL'); assert.equal(c.count, 3);
  assert.match(c.reason, /3 record\(s\) cannot be given a canonical key without guessing/);
  assert.match(c.reason, /ad_insights_daily\.google_ad_missing_ad_group_id=3/);
  assert.match(c.reason, /Nothing assigns them a key/);
  assert.deepEqual(c.by_reason, f.counts.unresolvable_reasons);
  assert.deepEqual(c.samples, f.counts.samples);
});

test('a present key that differs from the canonical derivation (a guessed or stale key) fails', () => {
  const r = readiness.evaluateReadiness(withTable('ad_ads', { wrong_keys: 2 }));
  assert.match(checkOf(r, 'canonical_keys_valid').reason, /2 key\(s\) differ from the canonical derivation \(ad_ads=2\)/);
  assert.equal(readiness.evaluateReadiness(withTable('ad_insights_daily', { malformed_keys: 1 })).status, 'FAIL');
});

test('keys that would collide under the scoped unique key block the index build', () => {
  const r = readiness.evaluateReadiness(withTable('ad_campaigns', { scoped_duplicates: 2 }));
  assert.match(checkOf(r, 'no_scoped_duplicates').reason, /2 group\(s\) would violate the scoped unique key \(ad_campaigns=2\)/);
});

test('scoped structure problems are listed one by one', () => {
  const idx = [...F.legacyIndexes(), ...F.scopedIndexes().slice(1)];
  const r = readiness.evaluateReadiness(goodFacts({ indexes: idx, constraints: F.keyConstraints({ convalidated: false }) }));
  const reason = checkOf(r, 'scoped_structure').reason;
  assert.match(reason, /index ad_insights_daily_scoped_uq is missing/);
  assert.match(reason, /constraint ad_ads_key_present is NOT VALID/);
});

test('the legacy unique keys must still exist: this gate is for the period before the key swap', () => {
  const r = readiness.evaluateReadiness(goodFacts({ indexes: F.scopedIndexes() }));
  assert.equal(checkOf(r, 'legacy_constraints_intact').status, 'FAIL');
  assert.match(checkOf(r, 'legacy_constraints_intact').reason, /ad_ads \(tenant_id, external_id\)/);
  assert.match(checkOf(r, 'legacy_constraints_intact').reason, /ad_insights_daily \(tenant_id, entity_type, entity_id, date\)/);
  assert.deepEqual(ai.missingLegacyKeys([...F.legacyIndexes(), ...F.scopedIndexes()]), []);
});

test('non-blocking observations are reported as warnings, not failures', () => {
  const f = goodFacts(); f.counts.warnings = { insights_currency_null: 41, ad_insight_rows_without_ad_row: 7 };
  const r = readiness.evaluateReadiness(f);
  assert.equal(r.status, 'PASS');
  assert.deepEqual(r.warnings, { insights_currency_null: 41, ad_insight_rows_without_ad_row: 7 });
});

// ---- collectFacts + run: strictly read-only ----------------------------------------------------------------------
const readinessDb = (spec = {}, count = () => 0) => {
  const st = F.structureDb({ state: 'dual_write', ...spec }); const log = [];
  return { log, query: async (sql, params) => {
    log.push(sql.trim());
    const p = st.answer(sql); if (p) return p;
    if (/^\s*(BEGIN READ ONLY|SET LOCAL|ROLLBACK)/.test(sql)) return { rows: [] };
    if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: count(sql) }] };
    if (/LIMIT 20/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  } };
};

test('run() sends only BEGIN READ ONLY, SET LOCAL, SELECTs and ROLLBACK, and never a write', async () => {
  const db = readinessDb({ indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() });
  const r = await readiness.run({ client: db });
  assert.equal(r.status, 'PASS');
  assert.equal(db.log[0], 'BEGIN READ ONLY');
  assert.equal(db.log[db.log.length - 1], 'ROLLBACK');
  for (const s of db.log) assert.match(s, /^(BEGIN READ ONLY|SET LOCAL statement_timeout|ROLLBACK|SELECT|WITH)/i, s.slice(0, 60));
  assert.ok(!db.log.some((s) => /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/i.test(s.replace(/'[^']*'/g, ''))));
});

test('with columns missing, no data query is sent at all (nothing to count) and the report is FAIL', async () => {
  const db = readinessDb({ columns: F.allColumns().slice(2) });
  const r = await readiness.run({ client: db });
  assert.equal(r.status, 'FAIL');
  assert.ok(!db.log.some((s) => /count\(\*\)/.test(s)));
  assert.match(checkOf(r, 'columns_present').reason, /2 column\(s\) missing/);
});

test('with a valid scoped unique index the duplicate scan is skipped (the index already guarantees it)', async () => {
  const db = readinessDb({ indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() });
  await readiness.run({ client: db });
  assert.ok(!db.log.some((s) => /HAVING count\(\*\) > 1/.test(s)));
  const noIdx = readinessDb({});
  await readiness.run({ client: noIdx });
  assert.equal(noIdx.log.filter((s) => /HAVING count\(\*\) > 1/.test(s)).length, 4);
});

test('the readiness SQL encodes the canonical derivation: Google ads are keyed by ad group, a key without an ad group is "wrong"', () => {
  const t = readiness.TABLE_SQL;
  assert.match(t.ad_ads.wrong, /s\.external_id \|\| '~' \|\| x\.external_id/);
  assert.match(t.ad_insights_daily.wrong, /nullif\(btrim\(coalesce\(x\.adset_external_id, ''\)\), ''\) \|\| '~' \|\| x\.entity_id/);
  assert.match(t.ad_insights_daily.unresolvable.google_ad_missing_ad_group_id, /a\.provider = 'google' AND x\.entity_type = 'ad'/);
  assert.match(t.ad_ads.unresolvable.google_ad_missing_ad_group_id, /a\.provider = 'google'/);
});

// ---- rollout transitions, including rollback ------------------------------------------------------------------
const rolloutDb = (state, spec = {}) => {
  const st = F.structureDb({ state, ...spec }); const log = []; const updates = [];
  let committed = state; let txn = state;
  return { st, log, updates, committed: () => committed, query: async (sql, params) => {
    log.push(sql.trim().split('\n')[0].slice(0, 70));
    if (sql === 'BEGIN') { txn = committed; return { rows: [] }; }
    if (sql === 'COMMIT') { committed = txn; st.spec.state = committed; return { rows: [] }; }
    if (sql === 'ROLLBACK') { txn = committed; return { rows: [] }; }
    if (/^SET LOCAL/.test(sql)) return { rows: [] };
    if (/INSERT INTO ad_identity_rollout/.test(sql)) { if (txn == null) txn = 'legacy'; return { rows: [] }; }
    if (/FOR UPDATE/.test(sql)) return { rows: [{ state: txn }] };
    if (/UPDATE ad_identity_rollout SET/.test(sql)) { txn = params[0]; updates.push(params); return { rows: [] }; }
    return st.answer(sql) || { rows: [] };
  } };
};
const pass = async () => ({ status: 'PASS', failing: [], checks: [] });
const fail = async () => ({ status: 'FAIL', failing: ['backfill_complete'], checks: [{ name: 'backfill_complete', status: 'FAIL', reason: '5 left' }] });
const fresh = async (db) => { ai.resetIdentityModeCache(); return ai.getIdentityMode(db, { force: true }); };

test('legacy -> scoped is refused: the path goes through dual_write', async () => {
  const db = rolloutDb('legacy');
  await assert.rejects(rollout.transition({ client: db, to: 'scoped', check: pass }), /cannot enter scoped from 'legacy'/);
  assert.equal(db.committed(), 'legacy'); assert.equal(db.updates.length, 0); assert.ok(db.log.includes('ROLLBACK'));
});

test('dual_write -> scoped requires a passing readiness verdict computed in the same transaction', async () => {
  let db = rolloutDb('dual_write', { indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() });
  await assert.rejects(rollout.transition({ client: db, to: 'scoped', check: fail }), (e) => /readiness FAILED \(backfill_complete\)/.test(e.message) && e.readiness.status === 'FAIL');
  assert.equal(db.committed(), 'dual_write'); assert.equal(db.updates.length, 0, 'no state change was attempted');
  assert.equal(await fresh(db), 'dual_write');

  db = rolloutDb('dual_write', { indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() });
  const res = await rollout.transition({ client: db, to: 'scoped', by: 'ops', note: 'go', check: pass });
  assert.deepEqual([res.from, res.to], ['dual_write', 'scoped']);
  assert.equal(db.committed(), 'scoped');
  assert.deepEqual(db.updates[0].slice(0, 3), ['scoped', 'ops', 'go']);
  assert.equal(JSON.parse(db.updates[0][3]).status, 'PASS', 'the verdict that justified the change is stored with it');
  assert.equal(await fresh(db), 'scoped');
});

test('setting scoped does not by itself make the app scoped when the structure is unusable', async () => {
  const db = rolloutDb('dual_write', { indexes: F.legacyIndexes(), constraints: [] });
  await rollout.transition({ client: db, to: 'scoped', check: pass }); // a (wrong) injected PASS
  assert.equal(db.committed(), 'scoped');
  assert.equal(await fresh(db), 'dual_write', 'the runtime guard re-verifies the structure on its own');
});

test('rollback: scoped -> dual_write needs no readiness, is instant, and leaves legacy keys and joins in charge', async () => {
  const db = rolloutDb('scoped', { indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() });
  assert.equal(await fresh(db), 'scoped');
  await rollout.transition({ client: db, to: 'dual_write', check: async () => { throw new Error('readiness must not run for a rollback'); } });
  assert.equal(db.committed(), 'dual_write');
  const mode = await fresh(db);
  assert.equal(mode, 'dual_write');
  assert.equal(ai.conflictTarget(mode, 'ad_ads'), '(tenant_id, external_id)');
  assert.ok(ai.writesKeys(mode) && !ai.readsScoped(mode), 'keys keep being written, reads are legacy again');
});

test('rollback to legacy is refused while the key-present constraints exist, and allowed once they are dropped', async () => {
  const db = rolloutDb('dual_write', { indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() });
  await assert.rejects(rollout.transition({ client: db, to: 'legacy' }), /refusing legacy: key-present constraint\(s\) exist \(.*ad_ads_key_present/);
  assert.equal(db.committed(), 'dual_write');
  db.st.spec.constraints = []; db.st.spec.indexes = F.legacyIndexes(); // rollback_03_indexes.sql was run
  await rollout.transition({ client: db, to: 'legacy' });
  assert.equal(await fresh(db), 'legacy');
});

test('a full cycle: legacy -> dual_write -> scoped -> dual_write -> legacy, each step explicit', async () => {
  const db = rolloutDb('legacy', { indexes: [...F.legacyIndexes(), ...F.scopedIndexes()], constraints: F.keyConstraints() });
  assert.equal(await fresh(db), 'legacy', 'everything is migrated but the app is still legacy until told otherwise');
  await rollout.transition({ client: db, to: 'dual_write' });
  assert.equal(await fresh(db), 'dual_write');
  await rollout.transition({ client: db, to: 'scoped', check: pass });
  assert.equal(await fresh(db), 'scoped');
  await rollout.transition({ client: db, to: 'dual_write' });
  assert.equal(await fresh(db), 'dual_write');
  db.st.spec.constraints = []; // constraints rolled back
  await rollout.transition({ client: db, to: 'legacy' });
  assert.equal(await fresh(db), 'legacy');
});

test('dual_write needs every column; an unapplied rollout table and unknown states are refused', async () => {
  const partial = rolloutDb('legacy', { columns: F.allColumns().slice(1) });
  await assert.rejects(rollout.transition({ client: partial, to: 'dual_write' }), /cannot enter dual_write: columns missing/);
  assert.equal(partial.committed(), 'legacy');
  await assert.rejects(rollout.transition({ client: rolloutDb(null, { rolloutPresent: false }), to: 'dual_write' }), /does not exist: apply models\/migration_ad_identity_rollout\.sql/);
  await assert.rejects(rollout.transition({ client: rolloutDb('legacy'), to: 'turbo' }), /unknown state/);
});

test('status reports the effective mode and why a scoped rollout is degraded', async () => {
  const db = rolloutDb('scoped', { indexes: F.legacyIndexes(), constraints: [] });
  const s = await rollout.status({ client: db });
  assert.equal(s.rollout_state, 'scoped'); assert.equal(s.effective_mode, 'dual_write');
  assert.match(s.reasons[0], /index ad_ads_scoped_uq is missing/);
});
