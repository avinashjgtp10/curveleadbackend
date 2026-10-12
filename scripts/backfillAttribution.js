#!/usr/bin/env node
// Creates attribution records for leads that existed BEFORE the attribution trigger was installed. DRY-RUN BY DEFAULT.
//   ATTRIBUTION_BACKFILL_URL=postgres://... node scripts/backfillAttribution.js --i-have-authorization [--tenant=<uuid>] [--apply] [--batch=500]
// Applying requires --tenant (one workspace at a time).
//  - The record is built from what the lead row says TODAY (source, campaign link, platform ids), labelled capture_basis
//    'backfill'. status: verified (platform ids present) / inferred (campaign link only) / unattributed (neither).
//  - Insert-only (ON CONFLICT DO NOTHING): an attribution that already exists is never touched.
//  - Cannot stop early (zero-row exit), keyset by lead id, one short transaction per batch, safe to rerun.
//  - Merged (absorbed) leads are skipped.
const run = async ({ client, tenantId = null, apply = false, batch = 500, log = () => {} }) => {
  batch = Number(batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > 5000) throw new Error('batch must be an integer between 1 and 5000');
  if (apply && !tenantId) throw new Error('Refusing --apply without --tenant: backfill one workspace at a time.');
  if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error('--tenant must be a workspace uuid');
  const ok = await client.query(`SELECT to_regclass('lead_attribution') IS NOT NULL AND to_regclass('lead_attribution_events') IS NOT NULL AS ok`);
  if (!ok.rows[0].ok) throw new Error('Attribution is not installed (models/migration_phase1_attribution.sql).');
  const report = { mode: apply ? 'APPLY' : 'DRY-RUN', scanned: 0, would_create: 0, created: 0, by_status: { verified: 0, inferred: 0, unattributed: 0 }, batches: 0 };
  const pick = (alias = 'l') => `
    SELECT ${alias}.id, ${alias}.tenant_id, to_jsonb(${alias}) AS j, ${alias}.campaign_id,
           CASE WHEN lead_has_platform_evidence(to_jsonb(${alias})) THEN 'verified' WHEN ${alias}.campaign_id IS NOT NULL THEN 'inferred' ELSE 'unattributed' END AS status
    FROM leads ${alias}
    WHERE ${alias}.merged_into_id IS NULL AND ($1::uuid IS NULL OR ${alias}.tenant_id = $1::uuid) AND ($2::uuid IS NULL OR ${alias}.id > $2::uuid)
      AND NOT EXISTS (SELECT 1 FROM lead_attribution a WHERE a.lead_id = ${alias}.id)
    ORDER BY ${alias}.id LIMIT $3`;
  try {
    let cursor = null;
    for (;;) {
      const leads = (await client.query(pick(), [tenantId, cursor, batch])).rows;
      if (!leads.length) break; // the only exit
      report.scanned += leads.length; report.would_create += leads.length;
      for (const l of leads) report.by_status[l.status]++;
      if (apply) {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL lock_timeout = '5s'`);
          const ids = leads.map((l) => l.id);
          const ins = await client.query(
            `INSERT INTO lead_attribution (lead_id, tenant_id, status, capture_basis, original_source, original_source_detail, original_crm_campaign_id, original_meta_lead_id, original_meta_ad_id,
                original_meta_adset_id, original_meta_form_id, original_google_lead_id, original_google_campaign_id, original_google_adgroup_id, original_google_creative_id, original_gclid, effective_crm_campaign_id)
             SELECT l.id, l.tenant_id, CASE WHEN lead_has_platform_evidence(to_jsonb(l)) THEN 'verified' WHEN l.campaign_id IS NOT NULL THEN 'inferred' ELSE 'unattributed' END, 'backfill',
                NULLIF(btrim(to_jsonb(l) ->> 'source'), ''), NULLIF(btrim(to_jsonb(l) ->> 'source_detail'), ''), l.campaign_id,
                NULLIF(btrim(to_jsonb(l) ->> 'meta_lead_id'), ''), NULLIF(btrim(to_jsonb(l) ->> 'meta_ad_id'), ''), NULLIF(btrim(to_jsonb(l) ->> 'meta_adset_id'), ''), NULLIF(btrim(to_jsonb(l) ->> 'meta_form_id'), ''),
                NULLIF(btrim(to_jsonb(l) ->> 'google_lead_id'), ''), NULLIF(btrim(to_jsonb(l) ->> 'google_campaign_id'), ''), NULLIF(btrim(to_jsonb(l) ->> 'google_adgroup_id'), ''),
                NULLIF(btrim(to_jsonb(l) ->> 'google_creative_id'), ''), NULLIF(btrim(to_jsonb(l) ->> 'gclid'), ''), l.campaign_id
             FROM leads l WHERE l.id = ANY($1::uuid[]) ON CONFLICT (lead_id) DO NOTHING`, [ids]);
          await client.query(
            `INSERT INTO lead_attribution_events (tenant_id, lead_id, event, after, reason)
             SELECT a.tenant_id, a.lead_id, 'captured', jsonb_build_object('status', a.status, 'crm_campaign_id', a.original_crm_campaign_id), 'backfilled from the lead as it was when attribution capture was installed'
             FROM lead_attribution a WHERE a.lead_id = ANY($1::uuid[]) AND a.capture_basis = 'backfill'
               AND NOT EXISTS (SELECT 1 FROM lead_attribution_events e WHERE e.lead_id = a.lead_id)`, [ids]);
          report.created += ins.rowCount;
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      } else { /* dry run: nothing is written, so the same rows would be returned again; page past them */ }
      report.batches++; cursor = leads[leads.length - 1].id;
      log(`scanned ${report.scanned}`);
    }
  } catch (e) { e.partialReport = report; throw e; }
  return report;
};

const main = async () => {
  const args = process.argv.slice(2);
  if (!args.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization once a database has been approved.'); process.exit(2); }
  const url = process.env.ATTRIBUTION_BACKFILL_URL;
  if (!url) { console.error('Refusing: set ATTRIBUTION_BACKFILL_URL (this script ignores DATABASE_URL).'); process.exit(2); }
  const tenantId = ((args.find((a) => a.startsWith('--tenant=')) || '').slice(9)) || null;
  const batch = Number((args.find((a) => a.startsWith('--batch=')) || '--batch=500').split('=')[1]);
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
module.exports = { run };
