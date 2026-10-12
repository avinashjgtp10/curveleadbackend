#!/usr/bin/env node
// Step 2 of the ad identity migration: fills entity_key / external_key / provider / ad_account_id / currency
// on existing rows. DRY-RUN BY DEFAULT: scans and reports, writes nothing.
//   AD_IDENTITY_BACKFILL_URL=postgres://... node scripts/backfillAdIdentity.js --i-have-authorization [--apply] [--batch=5000]
//
// Guarantees
//  - Cannot stop early. Each step walks its table by primary key (keyset pagination, strictly increasing
//    cursor) and ends only when a scan returns ZERO rows, never because a batch came back short. Rows that
//    cannot be keyed are skipped by the cursor, so they can neither stall the loop nor be retried forever.
//  - Resumable and safe to rerun. A step selects only rows that still lack a value; the UPDATE fills only
//    NULL columns (COALESCE) and re-checks that predicate. Existing values are never rewritten, legacy
//    columns are never touched, and a second run over a finished table updates nothing.
//  - Interruption loses nothing. One short transaction per batch: a crash or error rolls back only that
//    batch, earlier batches stay committed, and rerunning continues where the work remains.
//  - Never guesses. The key comes from adEntityKey(), the function the writers use. A row it cannot key
//    (Google ad with no ad group id, unknown provider, empty id) is left NULL and listed under
//    `unresolvable` with a reason; the run then exits 3 so automation cannot mistake it for a clean pass.
//  - --apply is refused unless the rollout state is dual_write or scoped. Otherwise running writers keep
//    inserting NULL-key rows behind the backfill and "complete" would not stay complete.
const ai = require('../services/adIdentity');

const SAMPLE_LIMIT = 20;
const PROVIDERS = new Set([ai.META, ai.GOOGLE]);
const blank = (v) => v == null || String(v).trim() === '';

// Per table: how to read candidates (always ordered by the primary key, filtered to rows still missing a value),
// how to derive the values for one candidate, and how to write a batch back. `derive` returns
// { fill } (values to write) or { unresolvable: reason }.
const STEPS = [
  {
    name: 'ad_campaigns',
    pk: ['x.id'], pkAlias: ['id'],
    select: `x.id, x.external_id, x.external_key, x.provider, a.provider AS account_provider`,
    from: `ad_campaigns x LEFT JOIN ad_accounts a ON a.id = x.ad_account_id AND a.tenant_id = x.tenant_id`,
    pending: `(x.external_key IS NULL OR x.provider IS NULL)`,
    cursorSql: (n) => `x.id > $${n}::uuid`, cursorParams: (r) => [r.id],
    derive: (r) => {
      if (!PROVIDERS.has(r.account_provider)) return { unresolvable: 'unknown_provider' };
      const key = ai.adEntityKey(r.account_provider, 'campaign', { id: r.external_id });
      return key ? { fill: { external_key: key, provider: r.account_provider } } : { unresolvable: 'empty_external_id' };
    },
    update: `UPDATE ad_campaigns x SET external_key = COALESCE(x.external_key, v.k), provider = COALESCE(x.provider, v.p)
             FROM unnest($1::uuid[], $2::text[], $3::text[]) AS v(id, k, p)
             WHERE x.id = v.id AND (x.external_key IS NULL OR x.provider IS NULL)`,
    args: (fills) => [fills.map((f) => f.id), fills.map((f) => f.external_key), fills.map((f) => f.provider)],
  },
  {
    name: 'ad_adsets',
    pk: ['x.id'], pkAlias: ['id'],
    select: `x.id, x.external_id, x.external_key, x.provider, x.ad_account_id, c.ad_account_id AS parent_account_id, a.provider AS account_provider`,
    from: `ad_adsets x LEFT JOIN ad_campaigns c ON c.id = x.ad_campaign_id AND c.tenant_id = x.tenant_id
           LEFT JOIN ad_accounts a ON a.id = c.ad_account_id AND a.tenant_id = c.tenant_id`,
    pending: `(x.external_key IS NULL OR x.provider IS NULL OR x.ad_account_id IS NULL)`,
    cursorSql: (n) => `x.id > $${n}::uuid`, cursorParams: (r) => [r.id],
    derive: (r) => {
      if (!PROVIDERS.has(r.account_provider) || !r.parent_account_id) return { unresolvable: 'unknown_provider' };
      const key = ai.adEntityKey(r.account_provider, 'adset', { id: r.external_id });
      return key ? { fill: { external_key: key, provider: r.account_provider, ad_account_id: r.parent_account_id } } : { unresolvable: 'empty_external_id' };
    },
    update: `UPDATE ad_adsets x SET external_key = COALESCE(x.external_key, v.k), provider = COALESCE(x.provider, v.p), ad_account_id = COALESCE(x.ad_account_id, v.a)
             FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[]) AS v(id, k, p, a)
             WHERE x.id = v.id AND (x.external_key IS NULL OR x.provider IS NULL OR x.ad_account_id IS NULL)`,
    args: (fills) => [fills.map((f) => f.id), fills.map((f) => f.external_key), fills.map((f) => f.provider), fills.map((f) => f.ad_account_id)],
  },
  {
    name: 'ad_ads',
    pk: ['x.id'], pkAlias: ['id'],
    select: `x.id, x.external_id, x.external_key, x.provider, x.ad_account_id, c.ad_account_id AS parent_account_id,
             s.external_id AS ad_group_id, a.provider AS account_provider`,
    from: `ad_ads x LEFT JOIN ad_adsets s ON s.id = x.ad_adset_id AND s.tenant_id = x.tenant_id
           LEFT JOIN ad_campaigns c ON c.id = s.ad_campaign_id AND c.tenant_id = s.tenant_id
           LEFT JOIN ad_accounts a ON a.id = c.ad_account_id AND a.tenant_id = c.tenant_id`,
    pending: `(x.external_key IS NULL OR x.provider IS NULL OR x.ad_account_id IS NULL)`,
    cursorSql: (n) => `x.id > $${n}::uuid`, cursorParams: (r) => [r.id],
    derive: (r) => {
      if (!PROVIDERS.has(r.account_provider) || !r.parent_account_id) return { unresolvable: 'unknown_provider' };
      if (blank(r.external_id)) return { unresolvable: 'empty_external_id' };
      // Google: the ad group is part of the key. No ad group id means no key, never the bare ad id.
      const key = ai.adEntityKey(r.account_provider, 'ad', { id: r.external_id, adGroupId: r.ad_group_id });
      return key ? { fill: { external_key: key, provider: r.account_provider, ad_account_id: r.parent_account_id } } : { unresolvable: 'google_ad_missing_ad_group_id' };
    },
    update: `UPDATE ad_ads x SET external_key = COALESCE(x.external_key, v.k), provider = COALESCE(x.provider, v.p), ad_account_id = COALESCE(x.ad_account_id, v.a)
             FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[]) AS v(id, k, p, a)
             WHERE x.id = v.id AND (x.external_key IS NULL OR x.provider IS NULL OR x.ad_account_id IS NULL)`,
    args: (fills) => [fills.map((f) => f.id), fills.map((f) => f.external_key), fills.map((f) => f.provider), fills.map((f) => f.ad_account_id)],
  },
  {
    name: 'ad_insights_daily',
    // No surrogate id: the legacy primary key is (tenant_id, entity_type, entity_id, date).
    pk: ['x.tenant_id', 'x.entity_type', 'x.entity_id', 'x.date'], pkAlias: ['tenant_id', 'entity_type', 'entity_id', 'date_s'],
    select: `x.tenant_id, x.entity_type, x.entity_id, to_char(x.date, 'YYYY-MM-DD') AS date_s, x.adset_external_id, x.entity_key, x.provider, x.currency,
             a.provider AS account_provider, a.currency AS account_currency`,
    from: `ad_insights_daily x LEFT JOIN ad_accounts a ON a.id = x.ad_account_id AND a.tenant_id = x.tenant_id`,
    // currency only counts as pending when the account has one to give, so a currency-less account cannot be rescanned forever.
    pending: `(x.entity_key IS NULL OR x.provider IS NULL OR (x.currency IS NULL AND a.currency IS NOT NULL))`,
    cursorSql: (n) => `(x.tenant_id, x.entity_type, x.entity_id, x.date) > ($${n}::uuid, $${n + 1}::text, $${n + 2}::text, $${n + 3}::date)`,
    cursorParams: (r) => [r.tenant_id, r.entity_type, r.entity_id, r.date_s],
    derive: (r) => {
      if (!PROVIDERS.has(r.account_provider)) return { unresolvable: 'unknown_provider' };
      if (blank(r.entity_id)) return { unresolvable: 'empty_external_id' };
      const key = ai.adEntityKey(r.account_provider, r.entity_type, { id: r.entity_id, adGroupId: r.adset_external_id });
      if (!key) return { unresolvable: 'google_ad_missing_ad_group_id' };
      return { fill: { entity_key: key, provider: r.account_provider, currency: r.account_currency || null } };
    },
    update: `UPDATE ad_insights_daily x SET entity_key = COALESCE(x.entity_key, v.k), provider = COALESCE(x.provider, v.p), currency = COALESCE(x.currency, v.c)
             FROM unnest($1::uuid[], $2::text[], $3::text[], $4::date[], $5::text[], $6::text[], $7::text[]) AS v(t, et, eid, d, k, p, c)
             WHERE x.tenant_id = v.t AND x.entity_type = v.et AND x.entity_id = v.eid AND x.date = v.d
               AND (x.entity_key IS NULL OR x.provider IS NULL OR x.currency IS NULL)`,
    args: (fills) => [fills.map((f) => f.tenant_id), fills.map((f) => f.entity_type), fills.map((f) => f.entity_id), fills.map((f) => f.date_s),
      fills.map((f) => f.entity_key), fills.map((f) => f.provider), fills.map((f) => f.currency)],
  },
];

const selectBatch = (step, cursor, batch) => {
  const where = [step.pending];
  const params = [];
  if (cursor) { where.push(step.cursorSql(1)); params.push(...step.cursorParams(cursor)); }
  params.push(batch);
  return {
    sql: `SELECT ${step.select} FROM ${step.from} WHERE ${where.join(' AND ')} ORDER BY ${step.pk.join(', ')} LIMIT $${params.length}`,
    params,
  };
};

const sameCursor = (a, b, step) => !!a && !!b && step.pkAlias.every((k) => String(a[k]) === String(b[k]));

// Pure-ish core, exported for tests: `client` needs only .query().
const run = async ({ client, apply = false, batch = 5000, log = () => {} }) => {
  batch = Number(batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > 50000) throw new Error('batch must be an integer between 1 and 50000');

  const rollout = await ai.readRollout(client);
  const report = { rollout_state: rollout.state, tables: {}, unresolvable: { total: 0, by_reason: {}, samples: [] } };
  if (apply && !(rollout.present && (rollout.state === 'dual_write' || rollout.state === 'scoped'))) {
    throw new Error(`Refusing --apply: rollout state is '${rollout.state || 'unset'}'. Set 'dual_write' first so concurrent writers stop creating NULL-key rows.`);
  }

  try {
    for (const step of STEPS) {
      const t = report.tables[step.name] = { scanned: 0, would_fill: 0, filled: 0, unresolvable: 0, batches: 0 };
      let cursor = null;
      for (;;) {
        const q = selectBatch(step, cursor, batch);
        const rows = (await client.query(q.sql, q.params)).rows;
        if (!rows.length) break; // the only exit: a scan that found nothing left after the cursor
        const fills = [];
        for (const r of rows) {
          const d = step.derive(r);
          if (d.unresolvable) {
            t.unresolvable++; report.unresolvable.total++;
            const k = `${step.name}.${d.unresolvable}`;
            report.unresolvable.by_reason[k] = (report.unresolvable.by_reason[k] || 0) + 1;
            if (report.unresolvable.samples.length < SAMPLE_LIMIT) report.unresolvable.samples.push({ table: step.name, reason: d.unresolvable, row: Object.fromEntries(step.pkAlias.map((a) => [a, r[a]])) });
          } else fills.push({ ...Object.fromEntries(step.pkAlias.map((a) => [a, r[a]])), ...d.fill });
        }
        t.scanned += rows.length; t.would_fill += fills.length; t.batches++;
        const next = rows[rows.length - 1];
        if (sameCursor(cursor, next, step)) throw new Error(`${step.name}: cursor did not advance; aborting instead of looping`);
        if (apply && fills.length) {
          await client.query('BEGIN');
          try {
            await client.query(`SET LOCAL lock_timeout = '5s'`);
            await client.query(`SET LOCAL statement_timeout = '120s'`);
            t.filled += (await client.query(step.update, step.args(fills))).rowCount;
            await client.query('COMMIT');
          } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
        }
        cursor = next;
        log(`${step.name}: scanned ${t.scanned}, ${apply ? `filled ${t.filled}` : `would fill ${t.would_fill}`}, unresolvable ${t.unresolvable}`);
      }
    }
  } catch (e) {
    e.partialReport = report; // what committed before the interruption; rerun to continue
    throw e;
  }
  return report;
};

const main = async () => {
  const args = process.argv.slice(2);
  if (!args.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization once a database has been approved.'); process.exit(2); }
  const url = process.env.AD_IDENTITY_BACKFILL_URL;
  if (!url) { console.error('Refusing: set AD_IDENTITY_BACKFILL_URL (this script ignores DATABASE_URL).'); process.exit(2); }
  const apply = args.includes('--apply');
  const batch = Number((args.find((a) => a.startsWith('--batch=')) || '--batch=5000').split('=')[1]);
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  let code = 0;
  try {
    const report = await run({ client, apply, batch, log: console.error });
    console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY-RUN', ...report }, null, 2));
    if (report.unresolvable.total) { console.error(`${report.unresolvable.total} record(s) could not be keyed and were left NULL (see "unresolvable"). Nothing guessed.`); code = 3; }
  } catch (e) {
    console.error(`Backfill stopped: ${e.message}`);
    if (e.partialReport) console.error(`Committed before stopping (rerun continues): ${JSON.stringify(e.partialReport.tables)}`);
    code = 1;
  } finally { await client.end(); }
  process.exit(code);
};

if (require.main === module) main();
module.exports = { STEPS, run, selectBatch };
