// Backfill control flow against an in-memory fake (no database): it cannot stop early, is resumable,
// idempotent and safe to rerun, survives an interrupted batch, and never guesses a key.
// The fake models transactions (ROLLBACK restores the rows) and the "fill only NULL" UPDATE; the real SQL is
// exercised by tests/adIdentitySql.test.js when ADS_TEST_DATABASE_URL points at an isolated database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, selectBatch, STEPS } = require('../scripts/backfillAdIdentity');
const F = require('./helpers/adIdentityFakes');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const campaign = (n, over = {}) => ({ id: id(n), external_id: String(1000 + n), external_key: null, provider: null, ad_account_id: 'acct', account_provider: 'meta', ...over });
const gAd = (n, group, over = {}) => ({ id: id(n), external_id: String(900 + n), external_key: null, provider: null, ad_account_id: null, parent_account_id: 'acctG', ad_group_id: group, account_provider: 'google', ...over });
const insight = (n, over = {}) => ({ tenant_id: id(1), entity_type: 'campaign', entity_id: String(n), date_s: '2026-10-01', adset_external_id: null, entity_key: null, provider: null, currency: null, account_provider: 'meta', account_currency: 'INR', ...over });

// ---- the early-stop bug ------------------------------------------------------------------------------
test('does not stop early when a batch contains rows that cannot be keyed (a short update must not end the loop)', async () => {
  // Every third ad is a Google ad with no ad group id: each batch of 10 fills only ~7, which is exactly
  // what used to make the loop think it was finished.
  const ads = Array.from({ length: 30 }, (_, i) => gAd(i + 1, (i + 1) % 3 === 0 ? null : '10'));
  const db = F.backfillDb({ ads });
  const report = await run({ client: db, apply: true, batch: 10 });
  const unkeyable = ads.filter((a) => a.ad_group_id == null);
  assert.equal(report.tables.ad_ads.filled, 20, 'all 20 keyable ads were filled across all batches');
  assert.equal(report.tables.ad_ads.unresolvable, 10);
  assert.ok(ads.filter((a) => a.ad_group_id != null).every((a) => a.external_key === `10~${a.external_id}` && a.provider === 'google' && a.ad_account_id === 'acctG'));
  assert.ok(unkeyable.every((a) => a.external_key === null && a.provider === null), 'unresolvable rows stay NULL');
  assert.ok(report.tables.ad_ads.batches >= 3);
});

test('works with any batch size, including 1, and fills exactly the same rows', async () => {
  for (const batch of [1, 2, 7, 100]) {
    const campaigns = Array.from({ length: 11 }, (_, i) => campaign(i + 1));
    const db = F.backfillDb({ campaigns });
    const report = await run({ client: db, apply: true, batch });
    assert.equal(report.tables.ad_campaigns.filled, 11, `batch=${batch}`);
    assert.ok(campaigns.every((c) => c.external_key === c.external_id && c.provider === 'meta'));
  }
});

test('a scan that returns the same row twice aborts instead of looping forever', async () => {
  const stuck = { rows: [campaign(1)] };
  const client = { query: async (sql) => {
    if (/to_regclass/.test(sql)) return { rows: [{ present: true }] };
    if (/FROM ad_identity_rollout/.test(sql)) return { rows: [{ state: 'dual_write' }] };
    return stuck;
  } };
  await assert.rejects(run({ client, batch: 5 }), /cursor did not advance/);
});

test('the cursor is the primary key and strictly increases (keyset pagination, no OFFSET)', () => {
  for (const step of STEPS) {
    const first = selectBatch(step, null, 50);
    assert.doesNotMatch(first.sql, /OFFSET/i, step.name);
    assert.match(first.sql, /ORDER BY/);
    assert.match(first.sql, new RegExp(step.pending.replace(/[()]/g, '\\$&').slice(0, 20)));
    const next = selectBatch(step, step.name === 'ad_insights_daily' ? { tenant_id: id(1), entity_type: 'ad', entity_id: '1', date_s: '2026-10-01' } : { id: id(5) }, 50);
    assert.match(next.sql, /\$1/); assert.equal(next.params[next.params.length - 1], 50);
  }
});

// ---- resumable / interrupted / repeated -------------------------------------------------------------------
test('an interrupted batch rolls back alone; earlier batches stay committed; the rerun finishes the rest', async () => {
  const campaigns = Array.from({ length: 10 }, (_, i) => campaign(i + 1));
  const db = F.backfillDb({ campaigns, failUpdateAt: 2 });
  let err;
  try { await run({ client: db, apply: true, batch: 3 }); } catch (e) { err = e; }
  assert.match(err.message, /connection lost/);
  assert.equal(err.partialReport.tables.ad_campaigns.filled, 3, 'only the first batch committed');
  assert.equal(campaigns.filter((c) => c.external_key).length, 3, 'the failing batch was rolled back, not half applied');
  assert.deepEqual(db.log.filter((l) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(l)), ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);

  db.setFailUpdateAt(null);
  const rerun = await run({ client: db, apply: true, batch: 3 });
  assert.equal(rerun.tables.ad_campaigns.filled, 7, 'the rerun only had the remaining rows to do');
  assert.ok(campaigns.every((c) => c.external_key === c.external_id && c.provider === 'meta'));
});

test('repeated execution is idempotent: a finished table is scanned, nothing is updated or locked', async () => {
  const campaigns = Array.from({ length: 6 }, (_, i) => campaign(i + 1));
  const db = F.backfillDb({ campaigns });
  await run({ client: db, apply: true, batch: 4 });
  const snapshot = JSON.stringify(campaigns);
  const updatesBefore = db.updateCalls();
  const again = await run({ client: db, apply: true, batch: 4 });
  const third = await run({ client: db, apply: true, batch: 4 });
  assert.equal(again.tables.ad_campaigns.filled, 0);
  assert.equal(third.tables.ad_campaigns.scanned, 0);
  assert.equal(db.updateCalls(), updatesBefore, 'no UPDATE is issued when nothing is pending');
  assert.equal(JSON.stringify(campaigns), snapshot, 'data is byte-identical after reruns');
});

test('existing values are never rewritten, even by a rerun that sees different input', async () => {
  const c = campaign(1, { external_key: 'KEEP', provider: null });
  const db = F.backfillDb({ campaigns: [c] });
  await run({ client: db, apply: true });
  assert.equal(c.external_key, 'KEEP', 'a present key is left alone (readiness, not the backfill, judges it)');
  assert.equal(c.provider, 'meta', 'only the missing column is filled');
});

test('the insights table has no id column: it is walked by its composite primary key', async () => {
  const rows = [insight(1), insight(2), insight(3, { entity_type: 'ad', adset_external_id: '10', account_provider: 'google' }), insight(4, { account_currency: null })];
  const db = F.backfillDb({ insights: rows });
  const report = await run({ client: db, apply: true, batch: 2 });
  assert.equal(report.tables.ad_insights_daily.filled, 4);
  assert.deepEqual(rows.map((r) => r.entity_key), ['1', '2', '10~3', '4']);
  assert.deepEqual(rows.map((r) => r.currency), ['INR', 'INR', 'INR', null], 'an account without a currency is not rescanned forever');
  assert.equal((await run({ client: db, apply: true, batch: 2 })).tables.ad_insights_daily.scanned, 0);
});

// ---- never guess ---------------------------------------------------------------------------------------
test('Google records without an ad group id are reported separately and never given a guessed key', async () => {
  const insights = [insight(1, { entity_type: 'ad', entity_id: '555', account_provider: 'google', adset_external_id: null }),
    insight(2, { entity_type: 'ad', entity_id: '556', account_provider: 'google', adset_external_id: '   ' }),
    insight(3, { entity_type: 'ad', entity_id: '557', account_provider: 'google', adset_external_id: '10' })];
  const ads = [gAd(1, null), gAd(2, '')];
  const db = F.backfillDb({ insights, ads });
  const report = await run({ client: db, apply: true });
  assert.equal(insights[0].entity_key, null); assert.equal(insights[1].entity_key, null);
  assert.equal(insights[2].entity_key, '10~557');
  assert.ok(ads.every((a) => a.external_key === null), 'not the bare ad id, not anything else');
  assert.equal(report.unresolvable.total, 4);
  assert.equal(report.unresolvable.by_reason['ad_insights_daily.google_ad_missing_ad_group_id'], 2);
  assert.equal(report.unresolvable.by_reason['ad_ads.google_ad_missing_ad_group_id'], 2);
  assert.ok(report.unresolvable.samples.length === 4 && report.unresolvable.samples.every((s) => s.table && s.reason && s.row));
  assert.ok(report.unresolvable.samples.every((s) => !('name' in s.row)), 'samples carry ids only');
});

test('unknown providers and empty ids are unresolvable too, with their own reasons', async () => {
  const campaigns = [campaign(1, { account_provider: 'tiktok' }), campaign(2, { external_id: '  ' }), campaign(3, { account_provider: null })];
  const db = F.backfillDb({ campaigns });
  const report = await run({ client: db, apply: true });
  assert.equal(report.tables.ad_campaigns.filled, 0);
  assert.deepEqual(report.unresolvable.by_reason, { 'ad_campaigns.unknown_provider': 2, 'ad_campaigns.empty_external_id': 1 });
});

test('the same Google ad id in two ad groups gets two distinct keys; a Meta ad keeps its own id', async () => {
  const ads = [gAd(1, '10', { external_id: '999' }), gAd(2, '11', { external_id: '999' }),
    { ...gAd(3, null, { external_id: '999' }), account_provider: 'meta', parent_account_id: 'acctM' }];
  const db = F.backfillDb({ ads });
  await run({ client: db, apply: true });
  assert.deepEqual(ads.map((a) => a.external_key), ['10~999', '11~999', '999']);
});

// ---- dry run and gating -------------------------------------------------------------------------------
test('dry run scans and reports but opens no transaction and issues no write', async () => {
  const campaigns = Array.from({ length: 5 }, (_, i) => campaign(i + 1));
  const db = F.backfillDb({ campaigns, state: null });
  const report = await run({ client: db, batch: 2 });
  assert.equal(report.tables.ad_campaigns.would_fill, 5);
  assert.equal(report.tables.ad_campaigns.filled, 0);
  assert.ok(campaigns.every((c) => c.external_key === null));
  assert.ok(!db.log.some((l) => /^(BEGIN|COMMIT|UPDATE|SET LOCAL)/.test(l)));
});

test('--apply is refused unless writers are already filling keys (rollout dual_write/scoped)', async () => {
  for (const state of [null, 'legacy']) {
    const db = F.backfillDb({ campaigns: [campaign(1)], state });
    await assert.rejects(run({ client: db, apply: true }), /Refusing --apply: rollout state is/, String(state));
    assert.equal(db.updateCalls(), 0);
  }
  for (const state of ['dual_write', 'scoped']) {
    const db = F.backfillDb({ campaigns: [campaign(1)], state });
    assert.equal((await run({ client: db, apply: true })).tables.ad_campaigns.filled, 1, state);
  }
});

test('batch size is validated', async () => {
  for (const batch of [0, -1, 1.5, 'abc', 100000]) await assert.rejects(run({ client: F.backfillDb(), batch }), /batch must be/, String(batch));
});

test('each batch is its own short transaction with lock and statement timeouts', async () => {
  const db = F.backfillDb({ campaigns: Array.from({ length: 4 }, (_, i) => campaign(i + 1)) });
  await run({ client: db, apply: true, batch: 2 });
  const seq = db.log.filter((l) => /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(l));
  assert.deepEqual(seq, ['BEGIN', 'SET LOCAL lock_timeout = \'5s\'', 'SET LOCAL statement_timeout = \'120s\'', 'COMMIT',
    'BEGIN', 'SET LOCAL lock_timeout = \'5s\'', 'SET LOCAL statement_timeout = \'120s\'', 'COMMIT']);
});

test('the backfill SQL only fills NULLs, never writes legacy columns, and joins no extra data it did not select', () => {
  for (const step of STEPS) {
    assert.match(step.update, /COALESCE\(x\./, step.name);
    assert.doesNotMatch(step.update, /SET [^W]*\b(external_id|entity_id|entity_type|date)\s*=/, step.name);
    assert.match(step.update, /\(x\.\w+ IS NULL/, `${step.name}: re-checks the NULL predicate at write time`);
  }
});
