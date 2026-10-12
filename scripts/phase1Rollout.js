#!/usr/bin/env node
// The remaining Phase 1 production work for ONE workspace, in the only safe order, with one report.
// DRY-RUN BY DEFAULT: without an --apply-* flag nothing is written (a missing migration is only reported).
//
//   PHASE1_ROLLOUT_URL=postgres://... node scripts/phase1Rollout.js --i-have-authorization --tenant=<workspace uuid>
//        [--apply-schema] [--apply-backfills] [--apply-advances] [--shadow] [--batch=500]
//
//   1. schema      attribution -> booking -> reporting migrations (each its own transaction, 5 s lock timeout, skipped if present)
//   2. milestones  backfill of "first qualified / first won" events for this workspace   (insert-only)
//   3. attribution backfill of attribution records for this workspace                     (insert-only)
//   4. advances    copy legacy advance_received amounts into the ledger as unknown-date payments (reviewed dry-run first)
//   5. health      the cohort health report
//   6. shadow      with --shadow: set reporting_cohort = 'shadow' for this workspace (only when health has no errors)
// Each step needs the one before it. The first problem stops the run and says why; every step is safe to rerun.
// Never reads DATABASE_URL or .env: it connects only to PHASE1_ROLLOUT_URL.
const fs = require('fs');
const path = require('path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATIONS = [
  ['lead_attribution', 'models/migration_phase1_attribution.sql'],
  ['v_lead_booked', 'models/migration_phase1_booking.sql'],
  ['metric_shadow_log', 'models/migration_phase1_reporting.sql'],
];
const PREREQUISITES = [['lead_milestone_events', 'models/migration_phase1_milestones.sql'], ['lead_payments', 'models/migration_phase1_lead_payments.sql']];

const parseArgs = (argv) => {
  const flag = (n) => argv.includes(`--${n}`);
  const val = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  return { authorized: flag('i-have-authorization'), tenantId: val('tenant'), applySchema: flag('apply-schema'), applyBackfills: flag('apply-backfills'),
    applyAdvances: flag('apply-advances'), shadow: flag('shadow'), batch: Number(val('batch') || 500) };
};

const present = async (client, name) => (await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).rows[0].ok;

// `deps` lets tests inject the step implementations.
const rollout = async ({ client, opts, root = path.join(__dirname, '..'), deps = {}, log = () => {} }) => {
  const d = {
    backfillMilestones: deps.backfillMilestones || require('./backfillMilestones').run,
    backfillAttribution: deps.backfillAttribution || require('./backfillAttribution').run,
    migrateAdvances: deps.migrateAdvances || require('./migrateAdvancePayments').run,
    getHealth: deps.getHealth || (async (tenantId) => require('../services/cohortMetrics').getHealth(tenantId)),
  };
  const report = { workspace: null, steps: {}, stopped: null };
  const stop = (step, why) => { report.stopped = { step, why }; return report; };

  if (!UUID.test(String(opts.tenantId || ''))) return stop('arguments', '--tenant must be a workspace uuid');
  const t = (await client.query('SELECT id, name, settings FROM tenants WHERE id = $1', [opts.tenantId])).rows[0];
  if (!t) return stop('arguments', 'No such workspace.');
  report.workspace = { id: t.id, name: t.name, reporting_cohort: (t.settings || {}).reporting_cohort || 'off', finance_ledger: (t.settings || {}).finance_ledger || 'off' };

  for (const [obj, file] of PREREQUISITES) if (!(await present(client, obj))) return stop('prerequisites', `${obj} is missing; apply ${file} first.`);

  // 1. schema
  report.steps.schema = {};
  for (const [obj, file] of MIGRATIONS) {
    if (await present(client, obj)) { report.steps.schema[file] = 'already applied'; continue; }
    if (!opts.applySchema) { report.steps.schema[file] = 'MISSING (rerun with --apply-schema to install it)'; continue; }
    await client.query('BEGIN');
    try { await client.query(`SET LOCAL lock_timeout = '5s'`); await client.query(fs.readFileSync(path.join(root, file), 'utf8')); await client.query('COMMIT'); }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); return stop('schema', `${file} failed and was rolled back: ${e.message}`); }
    report.steps.schema[file] = 'applied now'; log(`applied ${file}`);
  }
  const missing = Object.entries(report.steps.schema).filter(([, v]) => v.startsWith('MISSING'));
  if (missing.length) return stop('schema', `not installed yet: ${missing.map(([f]) => f).join(', ')}. This is a dry run; the later steps need them.`);

  // 2-3. backfills (insert-only, this workspace only)
  report.steps.milestones = await d.backfillMilestones({ client, apply: opts.applyBackfills, batch: opts.batch, tenantId: opts.tenantId, log });
  report.steps.attribution = await d.backfillAttribution({ client, tenantId: opts.tenantId, apply: opts.applyBackfills, batch: opts.batch, log });

  // 4. advances
  report.steps.advances = await d.migrateAdvances({ client, tenantId: opts.tenantId, apply: opts.applyAdvances, log });

  // 5. health
  report.steps.health = await d.getHealth(opts.tenantId);

  // 6. shadow
  if (opts.shadow) {
    if (!report.steps.health.ok) return stop('shadow', 'the health report has errors; cohort reporting was NOT switched to shadow.');
    await client.query(`UPDATE tenants SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('reporting_cohort', 'shadow') WHERE id = $1`, [opts.tenantId]);
    report.steps.shadow = "reporting_cohort set to 'shadow'";
  }
  return report;
};

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.authorized) { console.error('Refusing: pass --i-have-authorization once a database has been approved.'); process.exit(2); }
  const url = process.env.PHASE1_ROLLOUT_URL;
  if (!url) { console.error('Refusing: set PHASE1_ROLLOUT_URL (this script ignores DATABASE_URL and .env).'); process.exit(2); }
  if (!UUID.test(String(opts.tenantId || ''))) { console.error('Refusing: pass --tenant=<workspace uuid>. One workspace at a time.'); process.exit(2); }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  // The services read through config/db; point them at THIS connection so nothing can reach another database.
  const dbPath = require.resolve('../config/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: (s, p) => client.query(s, p), transaction: async (fn) => { await client.query('BEGIN'); try { const r = await fn(client); await client.query('COMMIT'); return r; } catch (e) { await client.query('ROLLBACK'); throw e; } }, pool: {} } };
  let code = 0;
  try {
    const report = await rollout({ client, opts, log: (m) => console.error(m) });
    console.log(JSON.stringify(report, null, 2));
    if (report.stopped) { console.error(`STOPPED at ${report.stopped.step}: ${report.stopped.why}`); code = 1; }
  } catch (e) { console.error(`FAILED: ${e.message}`); code = 1; } finally { await client.end(); }
  process.exit(code);
};

if (require.main === module) main();
module.exports = { rollout, parseArgs, MIGRATIONS, PREREQUISITES };
