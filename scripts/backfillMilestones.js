#!/usr/bin/env node
// Fills lead_milestone_events for leads that became qualified / won BEFORE the milestone trigger existed.
// DRY-RUN BY DEFAULT.
//   MILESTONE_BACKFILL_URL=postgres://... node scripts/backfillMilestones.js --i-have-authorization [--tenant=<workspace uuid>] [--apply] [--batch=500]
//
// Guarantees (same shape as the ad identity backfill)
//  - Cannot stop early: leads are walked by primary key with a strictly increasing cursor; the loop ends only
//    when a scan returns zero leads, never because a batch was short.
//  - Resumable / idempotent / safe to rerun: events are inserted with ON CONFLICT DO NOTHING against the
//    one-live-event-per-lead index, so a LIVE event always wins over a backfilled one and a second run adds nothing.
//  - One short transaction per batch; a failure rolls back only that batch.
//  - Never rewrites a stage, a lead or an existing event. Only inserts missing events.
//  - Dates come from real evidence, in this order: the first history row entering a won/qualified stage, then the
//    lead's own won_at (won only), then updated_at as a labelled last resort. Merged (absorbed) leads are skipped.
const WON_AT = `COALESCE(
  (SELECT min(h.changed_at) FROM lead_stage_history h JOIN lead_stages s ON s.tenant_id = h.tenant_id AND lower(trim(s.name)) = lower(trim(h.new_stage)) AND COALESCE(s.is_won, false)
    WHERE h.tenant_id = b.tenant_id AND h.lead_id = b.id),
  CASE WHEN EXISTS (SELECT 1 FROM lead_stages s WHERE s.tenant_id = b.tenant_id AND COALESCE(s.is_won, false) AND lower(trim(s.name)) = lower(trim(b.stage)))
       THEN COALESCE(b.won_at, b.updated_at) END)`;
const QUALIFIED_AT = `COALESCE(
  (SELECT min(h.changed_at) FROM lead_stage_history h JOIN lead_stages s ON s.tenant_id = h.tenant_id AND lower(trim(s.name)) = lower(trim(h.new_stage)) AND (COALESCE(s.is_won, false) OR COALESCE(s.is_qualified, false))
    WHERE h.tenant_id = b.tenant_id AND h.lead_id = b.id),
  CASE WHEN EXISTS (SELECT 1 FROM lead_stages s WHERE s.tenant_id = b.tenant_id AND (COALESCE(s.is_won, false) OR COALESCE(s.is_qualified, false)) AND lower(trim(s.name)) = lower(trim(b.stage)))
       THEN COALESCE(b.won_at, b.updated_at) END)`;

// One batch of leads strictly after the cursor. $1 cursor (nullable), $2 size.
const BATCH = `SELECT id, tenant_id, stage, won_at, updated_at FROM leads
  WHERE merged_into_id IS NULL AND ($1::uuid IS NULL OR id > $1::uuid) AND ($3::uuid IS NULL OR tenant_id = $3::uuid) ORDER BY id LIMIT $2`;

// What each batch would add / adds. `batch` is a CTE of the lead ids being processed ($1 = array of ids).
const candidates = (milestone, expr) => `
  SELECT b.tenant_id, b.id AS lead_id, '${milestone}'::text AS milestone, (${expr})::timestamptz AS at
  FROM leads b WHERE b.id = ANY($1::uuid[])`;
const COUNT_SQL = (milestone, expr) => `
  SELECT count(*)::int AS n FROM (${candidates(milestone, expr)}) c
  WHERE c.at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lead_milestone_events e WHERE e.lead_id = c.lead_id AND e.milestone = c.milestone AND NOT e.suppressed)`;
const INSERT_SQL = (milestone, expr) => `
  INSERT INTO lead_milestone_events (tenant_id, lead_id, milestone, occurred_at, source)
  SELECT c.tenant_id, c.lead_id, c.milestone, c.at, 'backfill' FROM (${candidates(milestone, expr)}) c WHERE c.at IS NOT NULL
  ON CONFLICT DO NOTHING`;

const run = async ({ client, apply = false, batch = 500, tenantId = null, log = () => {} }) => {
  batch = Number(batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > 5000) throw new Error('batch must be an integer between 1 and 5000');
  const report = { scanned: 0, batches: 0, won: { would_add: 0, added: 0 }, qualified: { would_add: 0, added: 0 } };
  const trigger = await client.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'lead_milestones_trigger' AND NOT tgisinternal AND tgenabled IN ('O', 'A')`);
  if (apply && !trigger.rows.length) {
    throw new Error('Refusing --apply: the milestone trigger is not installed and enabled, so new stage changes would not be recorded while this runs.');
  }
  try {
    let cursor = null;
    for (;;) {
      const leads = (await client.query(BATCH, [cursor, batch, tenantId])).rows;
      if (!leads.length) break; // the only exit
      const ids = leads.map((l) => l.id);
      const last = leads[leads.length - 1].id;
      if (cursor !== null && String(last) <= String(cursor)) throw new Error('cursor did not advance; aborting instead of looping');
      for (const [name, expr] of [['qualified', QUALIFIED_AT], ['won', WON_AT]]) {
        report[name].would_add += (await client.query(COUNT_SQL(name, expr), [ids])).rows[0].n;
      }
      if (apply) {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL lock_timeout = '5s'`);
          await client.query(`SET LOCAL statement_timeout = '120s'`);
          for (const [name, expr] of [['qualified', QUALIFIED_AT], ['won', WON_AT]]) report[name].added += (await client.query(INSERT_SQL(name, expr), [ids])).rowCount;
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      }
      report.scanned += leads.length; report.batches++; cursor = last;
      log(`scanned ${report.scanned}; won ${apply ? `+${report.won.added}` : `would add ${report.won.would_add}`}`);
    }
  } catch (e) { e.partialReport = report; throw e; }
  return report;
};

const main = async () => {
  const args = process.argv.slice(2);
  if (!args.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization once a database has been approved.'); process.exit(2); }
  const url = process.env.MILESTONE_BACKFILL_URL;
  if (!url) { console.error('Refusing: set MILESTONE_BACKFILL_URL (this script ignores DATABASE_URL).'); process.exit(2); }
  const batch = Number((args.find((a) => a.startsWith('--batch=')) || '--batch=500').split('=')[1]);
  const tenantId = ((args.find((a) => a.startsWith('--tenant=')) || '').slice(9)) || null;
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  let code = 0;
  try { console.log(JSON.stringify({ mode: args.includes('--apply') ? 'APPLY' : 'DRY-RUN', ...(await run({ client, apply: args.includes('--apply'), batch, tenantId, log: console.error })) }, null, 2)); }
  catch (e) { console.error(`Backfill stopped: ${e.message}`); if (e.partialReport) console.error(`Committed before stopping (rerun continues): ${JSON.stringify(e.partialReport)}`); code = 1; }
  finally { await client.end(); }
  process.exit(code);
};

if (require.main === module) main();
module.exports = { run, BATCH };
