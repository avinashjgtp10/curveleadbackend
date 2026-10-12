#!/usr/bin/env node
// Copies legacy leads.advance_received amounts into the payment ledger, for ONE workspace at a time.
// DRY-RUN BY DEFAULT.
//   ADVANCE_MIGRATION_URL=postgres://... node scripts/migrateAdvancePayments.js --i-have-authorization --tenant=<workspace-uuid> [--apply] [--batch=200]
//
// What it writes: one COMPLETED payment per lead, amount = the advance, currency = the workspace currency, with the date
// basis 'unknown' (the old field never recorded when the money arrived; edits to it were not logged). The lead's Won date
// is stored only as an "approximately" hint (estimated_paid_on) and is never presented as a payment date.
// Guarantees
//  - Idempotent: the idempotency key is deterministic (migrate-advance:<lead id>), so a rerun inserts nothing new.
//  - A lead that ALREADY has any ledger row is skipped (never double counted); skipped counts are reported.
//  - Merged (absorbed) leads are NOT migrated automatically: their advances are listed for a finance review, because the
//    old merge kept only the maximum and the intended amount cannot be known.
//  - A lead whose stage is not Won but has an advance is migrated and flagged in the notes ("anomaly").
//  - Cannot stop early (zero-row exit), one short transaction per batch, no leads or other data are touched.
const SAMPLE = 20;
const KEY = (leadId) => `migrate-advance:${leadId}`;

const run = async ({ client, tenantId, apply = false, batch = 200, log = () => {} }) => {
  batch = Number(batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > 2000) throw new Error('batch must be an integer between 1 and 2000');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(tenantId || ''))) throw new Error('--tenant must be a workspace uuid');
  const tables = await client.query(`SELECT to_regclass('lead_payments') IS NOT NULL AS ok`);
  if (!tables.rows[0].ok) throw new Error('The payment ledger is not installed (models/migration_phase1_lead_payments.sql).');
  const t = (await client.query(`SELECT id, name, settings FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  if (!t) throw new Error('No such workspace.');
  const cur = t.settings && /^[A-Z]{3}$/.test(t.settings.currency || '') ? t.settings.currency : 'INR';

  const report = { workspace: t.name, currency: cur, mode: apply ? 'APPLY' : 'DRY-RUN', scanned: 0, migrated: 0, would_migrate: 0, total_amount: 0, skipped_has_ledger_rows: 0,
    not_won_anomalies: 0, absorbed_review: { leads: 0, total_amount: 0, samples: [] }, batches: 0 };

  // Absorbed leads with an advance: reported for review, never migrated here.
  const absorbed = await client.query(
    `SELECT id, merged_into_id, advance_received FROM leads WHERE tenant_id = $1 AND merged_into_id IS NOT NULL AND COALESCE(advance_received, 0) > 0 ORDER BY id`, [tenantId]);
  report.absorbed_review.leads = absorbed.rows.length;
  report.absorbed_review.total_amount = Math.round(absorbed.rows.reduce((a, r) => a + Number(r.advance_received), 0) * 100) / 100;
  report.absorbed_review.samples = absorbed.rows.slice(0, SAMPLE).map((r) => ({ lead_id: r.id, merged_into: r.merged_into_id, advance_received: Number(r.advance_received) }));

  try {
    let cursor = null;
    for (;;) {
      const leads = (await client.query(
        `SELECT l.id, l.advance_received, l.won_at, to_char(l.won_at, 'YYYY-MM-DD') AS won_on,
                EXISTS (SELECT 1 FROM lead_payments p WHERE p.lead_id = l.id) AS has_ledger,
                lower(trim(l.stage)) IN (SELECT lower(trim(s.name)) FROM lead_stages s WHERE s.tenant_id = l.tenant_id AND s.is_won) AS in_won_stage
         FROM leads l WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL AND COALESCE(l.advance_received, 0) > 0 AND ($2::uuid IS NULL OR l.id > $2::uuid)
         ORDER BY l.id LIMIT $3`, [tenantId, cursor, batch])).rows;
      if (!leads.length) break; // the only exit
      const todo = leads.filter((l) => !l.has_ledger);
      report.scanned += leads.length; report.skipped_has_ledger_rows += leads.length - todo.length;
      report.not_won_anomalies += todo.filter((l) => !l.in_won_stage).length;
      report.would_migrate += todo.length;
      if (apply && todo.length) {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL lock_timeout = '5s'`);
          for (const l of todo) {
            const r = await client.query(
              `INSERT INTO lead_payments (tenant_id, lead_id, kind, status, amount, currency, paid_on, paid_on_basis, estimated_paid_on, method, notes, idempotency_key, source)
               VALUES ($1,$2,'payment','completed',$3,$4,NULL,'unknown',$5,'migrated_advance',$6,$7,'migration') ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
              [tenantId, l.id, Number(l.advance_received), cur, l.won_on || null,
                `Migrated from the old "advance received" field; the payment date was never recorded.${l.in_won_stage ? '' : ' Anomaly: the lead was not in a Won stage.'}`, KEY(l.id)]);
            report.migrated += r.rowCount; report.total_amount = Math.round((report.total_amount + (r.rowCount ? Number(l.advance_received) : 0)) * 100) / 100;
          }
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      }
      report.batches++; cursor = leads[leads.length - 1].id;
      log(`scanned ${report.scanned}, ${apply ? `migrated ${report.migrated}` : `would migrate ${report.would_migrate}`}`);
    }
  } catch (e) { e.partialReport = report; throw e; }
  return report;
};

const main = async () => {
  const args = process.argv.slice(2);
  if (!args.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization once a database has been approved.'); process.exit(2); }
  const url = process.env.ADVANCE_MIGRATION_URL;
  if (!url) { console.error('Refusing: set ADVANCE_MIGRATION_URL (this script ignores DATABASE_URL).'); process.exit(2); }
  const tenantId = (args.find((a) => a.startsWith('--tenant=')) || '').slice(9);
  if (!tenantId) { console.error('Refusing: pass --tenant=<workspace uuid>. One workspace at a time.'); process.exit(2); }
  const batch = Number((args.find((a) => a.startsWith('--batch=')) || '--batch=200').split('=')[1]);
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  let code = 0;
  try { console.log(JSON.stringify(await run({ client, tenantId, apply: args.includes('--apply'), batch, log: console.error }), null, 2)); }
  catch (e) { console.error(`Stopped: ${e.message}`); if (e.partialReport) console.error(`Committed before stopping (rerun continues): ${JSON.stringify(e.partialReport)}`); code = 1; }
  finally { await client.end(); }
  process.exit(code);
};

if (require.main === module) main();
module.exports = { run, KEY };
