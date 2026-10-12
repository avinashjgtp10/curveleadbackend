#!/usr/bin/env node
// READ-ONLY readiness gate for account-scoped ad identity. Answers one question: may the rollout state
// be moved to 'scoped'? Prints a JSON report (status PASS/FAIL, one entry per check with a reason and a
// count) and exits 0 on PASS, 1 on FAIL, 2 if it refuses to run. It never modifies the database:
// the only statements it sends are BEGIN READ ONLY, SET LOCAL statement_timeout, SELECTs and ROLLBACK.
//
//   AD_IDENTITY_READINESS_URL=postgres://... node scripts/adIdentityReadiness.js --i-have-authorization
//
// Ignores DATABASE_URL on purpose, so it cannot reach an environment by accident.
const ai = require('../services/adIdentity');

const UNKNOWN_PROVIDER = `NOT IN ('meta', 'google')`;
const GOOGLE_AD_GROUP_BLANK = (expr) => `btrim(coalesce(${expr}, '')) = ''`;

// Each table: how to reach the owning ad account, which rows still lack a key, which of those can never
// get one without guessing, and what the canonical key/provider must equal when present.
const TABLE_SQL = {
  ad_campaigns: {
    from: `ad_campaigns x LEFT JOIN ad_accounts a ON a.id = x.ad_account_id AND a.tenant_id = x.tenant_id`,
    nullKey: `(x.external_key IS NULL OR x.provider IS NULL)`,
    unresolvable: {
      unknown_provider: `a.provider IS NULL OR a.provider ${UNKNOWN_PROVIDER}`,
      empty_external_id: `btrim(x.external_id) = ''`,
    },
    wrong: `(x.external_key IS NOT NULL AND x.external_key <> x.external_id) OR (x.provider IS NOT NULL AND x.provider IS DISTINCT FROM a.provider)`,
    malformed: `x.external_key ~ '~' OR btrim(x.external_key) = ''`,
  },
  ad_adsets: {
    from: `ad_adsets x LEFT JOIN ad_campaigns c ON c.id = x.ad_campaign_id AND c.tenant_id = x.tenant_id
           LEFT JOIN ad_accounts a ON a.id = c.ad_account_id AND a.tenant_id = c.tenant_id`,
    nullKey: `(x.external_key IS NULL OR x.provider IS NULL OR x.ad_account_id IS NULL)`,
    unresolvable: {
      unknown_provider: `a.provider IS NULL OR a.provider ${UNKNOWN_PROVIDER}`,
      empty_external_id: `btrim(x.external_id) = ''`,
    },
    wrong: `(x.external_key IS NOT NULL AND x.external_key <> x.external_id) OR (x.provider IS NOT NULL AND x.provider IS DISTINCT FROM a.provider)
            OR (x.ad_account_id IS NOT NULL AND x.ad_account_id IS DISTINCT FROM c.ad_account_id)`,
    malformed: `x.external_key ~ '~' OR btrim(x.external_key) = ''`,
  },
  ad_ads: {
    from: `ad_ads x LEFT JOIN ad_adsets s ON s.id = x.ad_adset_id AND s.tenant_id = x.tenant_id
           LEFT JOIN ad_campaigns c ON c.id = s.ad_campaign_id AND c.tenant_id = s.tenant_id
           LEFT JOIN ad_accounts a ON a.id = c.ad_account_id AND a.tenant_id = c.tenant_id`,
    nullKey: `(x.external_key IS NULL OR x.provider IS NULL OR x.ad_account_id IS NULL)`,
    unresolvable: {
      unknown_provider: `a.provider IS NULL OR a.provider ${UNKNOWN_PROVIDER}`,
      empty_external_id: `btrim(x.external_id) = ''`,
      google_ad_missing_ad_group_id: `a.provider = 'google' AND ${GOOGLE_AD_GROUP_BLANK('s.external_id')}`,
    },
    wrong: `(x.external_key IS NOT NULL AND x.external_key IS DISTINCT FROM CASE WHEN a.provider = 'google' THEN s.external_id || '~' || x.external_id ELSE x.external_id END)
            OR (x.provider IS NOT NULL AND x.provider IS DISTINCT FROM a.provider)
            OR (x.ad_account_id IS NOT NULL AND x.ad_account_id IS DISTINCT FROM c.ad_account_id)`,
    malformed: `x.external_key IS NOT NULL AND (btrim(x.external_key) = '' OR (a.provider = 'google' AND x.external_key !~ '^[^~]+~[^~]+$') OR (a.provider = 'meta' AND x.external_key ~ '~'))`,
  },
  ad_insights_daily: {
    from: `ad_insights_daily x LEFT JOIN ad_accounts a ON a.id = x.ad_account_id AND a.tenant_id = x.tenant_id`,
    nullKey: `(x.entity_key IS NULL OR x.provider IS NULL)`,
    unresolvable: {
      unknown_provider: `a.provider IS NULL OR a.provider ${UNKNOWN_PROVIDER}`,
      empty_external_id: `btrim(x.entity_id) = ''`,
      google_ad_missing_ad_group_id: `a.provider = 'google' AND x.entity_type = 'ad' AND ${GOOGLE_AD_GROUP_BLANK('x.adset_external_id')}`,
    },
    // A key present for a Google ad row without an ad group is a guessed key: expected is NULL, so IS DISTINCT FROM flags it.
    wrong: `(x.entity_key IS NOT NULL AND x.entity_key IS DISTINCT FROM CASE WHEN a.provider = 'google' AND x.entity_type = 'ad'
                 THEN nullif(btrim(coalesce(x.adset_external_id, '')), '') || '~' || x.entity_id ELSE x.entity_id END)
            OR (x.provider IS NOT NULL AND x.provider IS DISTINCT FROM a.provider)`,
    malformed: `x.entity_key IS NOT NULL AND (btrim(x.entity_key) = '' OR (a.provider = 'google' AND x.entity_type = 'ad' AND x.entity_key !~ '^[^~]+~[^~]+$')
                 OR (NOT (a.provider = 'google' AND x.entity_type = 'ad') AND x.entity_key ~ '~'))`,
  },
};

const DUP_SQL = {
  ad_campaigns: `SELECT count(*)::int AS n FROM (SELECT 1 FROM ad_campaigns WHERE external_key IS NOT NULL GROUP BY tenant_id, ad_account_id, external_key HAVING count(*) > 1) d`,
  ad_adsets: `SELECT count(*)::int AS n FROM (SELECT 1 FROM ad_adsets WHERE external_key IS NOT NULL AND ad_account_id IS NOT NULL GROUP BY tenant_id, ad_account_id, external_key HAVING count(*) > 1) d`,
  ad_ads: `SELECT count(*)::int AS n FROM (SELECT 1 FROM ad_ads WHERE external_key IS NOT NULL AND ad_account_id IS NOT NULL GROUP BY tenant_id, ad_account_id, external_key HAVING count(*) > 1) d`,
  ad_insights_daily: `SELECT count(*)::int AS n FROM (SELECT 1 FROM ad_insights_daily WHERE entity_key IS NOT NULL GROUP BY tenant_id, ad_account_id, entity_type, entity_key, date HAVING count(*) > 1) d`,
};

const MIN_DUAL_WRITE_SECONDS = 15 * 60; // instances cache the mode for up to 60 s and syncs can run long

const count = async (client, sql, params) => (await client.query(sql, params)).rows[0].n;

// All reads, no writes. `client` may be a pooled client or a pool; the caller owns the transaction.
const collectFacts = async (client) => {
  const rollout = await ai.readRollout(client);
  if (rollout.present && rollout.row) {
    rollout.age_seconds = (await client.query(`SELECT extract(epoch FROM (now() - updated_at))::int AS s FROM ${ai.ROLLOUT_TABLE} WHERE id = 1`)).rows[0].s;
  }
  const columns = await ai.readColumns(client);
  const facts = {
    rollout: { present: rollout.present, state: rollout.state, age_seconds: rollout.age_seconds == null ? null : rollout.age_seconds },
    missing_columns: ai.missingColumns(columns),
    indexes: await ai.readUniqueIndexes(client),
    constraints: await ai.readKeyConstraints(client),
    counts: null,
  };
  if (facts.missing_columns.length) return facts;

  const counts = { by_table: {}, unresolvable_reasons: {}, samples: [] };
  const indexValid = (name) => facts.indexes.some((i) => i.index_name === name && i.indisvalid && i.indisready);
  for (const [table, t] of Object.entries(TABLE_SQL)) {
    const anyUnresolvable = Object.values(t.unresolvable).map((p) => `(${p})`).join(' OR ');
    const entry = {};
    entry.null_keys = await count(client, `SELECT count(*)::int AS n FROM ${t.from} WHERE ${t.nullKey}`);
    entry.unresolvable = await count(client, `SELECT count(*)::int AS n FROM ${t.from} WHERE ${t.nullKey} AND (${anyUnresolvable})`);
    for (const [reason, pred] of Object.entries(t.unresolvable)) {
      const n = await count(client, `SELECT count(*)::int AS n FROM ${t.from} WHERE ${t.nullKey} AND (${pred})`);
      if (n) counts.unresolvable_reasons[`${table}.${reason}`] = n;
    }
    entry.wrong_keys = await count(client, `SELECT count(*)::int AS n FROM ${t.from} WHERE ${t.wrong}`);
    entry.malformed_keys = await count(client, `SELECT count(*)::int AS n FROM ${t.from} WHERE ${t.malformed}`);
    const idxName = Object.keys(ai.SCOPED_INDEX_SPECS).find((n) => ai.SCOPED_INDEX_SPECS[n].table === table);
    // A valid unique index already guarantees no duplicates; only scan when it is not there yet.
    entry.scoped_duplicates = indexValid(idxName) ? 0 : await count(client, DUP_SQL[table]);
    counts.by_table[table] = entry;
  }
  // Samples of the Google ad insight rows that cannot be keyed (ids only, never names or lead data).
  counts.samples = (await client.query(
    `SELECT x.ad_account_id, x.entity_id AS ad_id, count(*)::int AS rows
     FROM ad_insights_daily x JOIN ad_accounts a ON a.id = x.ad_account_id AND a.tenant_id = x.tenant_id AND a.provider = 'google'
     WHERE x.entity_type = 'ad' AND x.entity_key IS NULL AND btrim(coalesce(x.adset_external_id, '')) = ''
     GROUP BY 1, 2 ORDER BY rows DESC LIMIT 20`)).rows;
  counts.warnings = {
    insights_currency_null: columns.has('ad_insights_daily.currency')
      ? await count(client, `SELECT count(*)::int AS n FROM ad_insights_daily WHERE currency IS NULL`) : null,
    ad_insight_rows_without_ad_row: await count(client,
      `SELECT count(*)::int AS n FROM ad_insights_daily x WHERE x.entity_type = 'ad' AND x.entity_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ad_ads a WHERE a.tenant_id = x.tenant_id AND a.ad_account_id = x.ad_account_id AND a.external_key = x.entity_key)`),
  };
  facts.counts = counts;
  return facts;
};

const check = (name, ok, reason, n = null, extra = {}) => ({ name, status: ok ? 'PASS' : 'FAIL', reason, count: n, ...extra });
const sum = (obj, key) => Object.values(obj).reduce((a, e) => a + (e[key] || 0), 0);
const perTable = (obj, key) => Object.entries(obj).filter(([, e]) => e[key]).map(([t, e]) => `${t}=${e[key]}`).join(', ');

// Pure: facts in, PASS/FAIL report out.
const evaluateReadiness = (facts) => {
  const checks = [];
  const r = facts.rollout || {};
  const cannot = 'cannot be evaluated until the columns exist';

  checks.push(check('columns_present', facts.missing_columns.length === 0,
    facts.missing_columns.length ? `migration incomplete: ${facts.missing_columns.length} column(s) missing: ${facts.missing_columns.join(', ')}` : 'all identity columns exist',
    facts.missing_columns.length));

  const stateOk = r.present && (r.state === 'dual_write' || r.state === 'scoped');
  checks.push(check('rollout_state', !!stateOk,
    !r.present ? `${ai.ROLLOUT_TABLE} does not exist (rollout migration not applied)`
      : stateOk ? `rollout state is '${r.state}'` : `rollout state is '${r.state || 'unset'}'; set 'dual_write' first so writers populate keys, then rerun the backfill`));

  const soakNeeded = r.state === 'dual_write';
  const soakOk = !soakNeeded || (r.age_seconds != null && r.age_seconds >= MIN_DUAL_WRITE_SECONDS);
  checks.push(check('dual_write_soak', stateOk ? soakOk : false,
    !stateOk ? 'dual_write is not active' : soakOk ? 'dual_write has been active long enough for every instance and in-flight sync to pick it up'
      : `dual_write was set ${r.age_seconds}s ago; wait at least ${MIN_DUAL_WRITE_SECONDS}s, then rerun the backfill and this check`, r.age_seconds));

  if (!facts.counts) {
    for (const n of ['backfill_complete', 'unresolvable_records', 'canonical_keys_valid', 'no_scoped_duplicates']) checks.push(check(n, false, `${cannot} (columns missing)`));
  } else {
    const t = facts.counts.by_table;
    const pending = Object.fromEntries(Object.entries(t).map(([k, e]) => [k, { backfillable: e.null_keys - e.unresolvable }]));
    const pendingTotal = Object.values(pending).reduce((a, e) => a + e.backfillable, 0);
    checks.push(check('backfill_complete', pendingTotal === 0,
      pendingTotal ? `backfill incomplete: ${pendingTotal} record(s) still lack a key but can be keyed (${Object.entries(pending).filter(([, e]) => e.backfillable).map(([k, e]) => `${k}=${e.backfillable}`).join(', ')}); rerun scripts/backfillAdIdentity.js --apply`
        : 'every record that can be keyed has a key', pendingTotal));

    const unresolvable = sum(t, 'unresolvable');
    checks.push(check('unresolvable_records', unresolvable === 0,
      unresolvable ? `${unresolvable} record(s) cannot be given a canonical key without guessing and were left NULL (${Object.entries(facts.counts.unresolvable_reasons).map(([k, v]) => `${k}=${v}`).join(', ')}); the owner must decide to repair or retire them. Nothing assigns them a key.`
        : 'no unresolvable records', unresolvable, { by_reason: facts.counts.unresolvable_reasons, samples: facts.counts.samples }));

    const wrong = sum(t, 'wrong_keys'), malformed = sum(t, 'malformed_keys');
    checks.push(check('canonical_keys_valid', wrong + malformed === 0,
      wrong + malformed ? `${wrong} key(s) differ from the canonical derivation (${perTable(t, 'wrong_keys') || 'none'}), ${malformed} malformed (${perTable(t, 'malformed_keys') || 'none'})`
        : 'every present key equals its canonical derivation', wrong + malformed));

    const dups = sum(t, 'scoped_duplicates');
    checks.push(check('no_scoped_duplicates', dups === 0,
      dups ? `${dups} group(s) would violate the scoped unique key (${perTable(t, 'scoped_duplicates')}); the unique index cannot be built until they are resolved`
        : 'no duplicate scoped keys (or a valid unique index already guarantees it)', dups));
  }

  const problems = ai.scopedProblems({ indexes: facts.indexes, constraints: facts.constraints });
  checks.push(check('scoped_structure', problems.length === 0,
    problems.length ? `scoped structure incomplete: ${problems.join('; ')}` : 'scoped unique indexes are valid and key-present constraints are validated', problems.length));

  const legacyMissing = ai.missingLegacyKeys(facts.indexes);
  checks.push(check('legacy_constraints_intact', legacyMissing.length === 0,
    legacyMissing.length ? `legacy unique key(s) missing: ${legacyMissing.join('; ')} (this gate is for the period BEFORE the separately approved key swap)`
      : 'legacy unique keys are all still in force', legacyMissing.length));

  const w = facts.counts && facts.counts.warnings;
  const warnings = w ? {
    insights_currency_null: w.insights_currency_null,
    ad_insight_rows_without_ad_row: w.ad_insight_rows_without_ad_row,
  } : {};

  const failing = checks.filter((c) => c.status === 'FAIL');
  return { status: failing.length ? 'FAIL' : 'PASS', failing: failing.map((c) => c.name), checks, warnings };
};

const run = async ({ client }) => {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = '300s'`);
    return evaluateReadiness(await collectFacts(client));
  } finally {
    await client.query('ROLLBACK');
  }
};

const main = async () => {
  if (!process.argv.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization once a database has been approved for the readiness check.'); process.exit(2); }
  const url = process.env.AD_IDENTITY_READINESS_URL;
  if (!url) { console.error('Refusing: set AD_IDENTITY_READINESS_URL (this script ignores DATABASE_URL).'); process.exit(2); }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  let report;
  try { report = await run({ client }); } finally { await client.end(); }
  console.log(JSON.stringify(report, null, 2));
  console.error(`READINESS: ${report.status}${report.failing.length ? ` — failing: ${report.failing.join(', ')}` : ''}`);
  for (const c of report.checks.filter((x) => x.status === 'FAIL')) console.error(` - ${c.name}: ${c.reason}`);
  process.exit(report.status === 'PASS' ? 0 : 1);
};

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(2); });
module.exports = { TABLE_SQL, MIN_DUAL_WRITE_SECONDS, collectFacts, evaluateReadiness, run };
