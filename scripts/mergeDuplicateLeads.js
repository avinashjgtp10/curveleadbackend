// Batch 1 (B): normalise every lead phone to E.164 (each workspace's own country for
// numbers without a country code) and soft-merge duplicate leads (services/leadMerge.js).
//
//   node scripts/mergeDuplicateLeads.js                 dry run: counts + report file, writes nothing
//   node scripts/mergeDuplicateLeads.js --apply         merges + reformats, one transaction per group
//   options: --tenant <uuid>   only one workspace
//            --report <file>   where to write the JSON report (default ./merge-report-<time>.json)
//
// Requires models/migration_batch1_leads_merge.sql. Invalid numbers are listed, never changed.
require('dotenv').config();
const fs = require('fs');
const { query, transaction, pool } = require('../config/db');
const { normalizePhone } = require('../utils/dataQuality');
const { localeFromSettings } = require('../utils/workspaceLocale');
const { planMerge, loadContext, applyMerge, childTables } = require('../services/leadMerge');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const reportPath = opt('--report') || `merge-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

// Groups a workspace's live leads by E.164 phone; also returns reformat + invalid lists.
const analyseTenant = (leads, country) => {
  const groups = new Map(), reformat = [], invalid = [];
  for (const l of leads) {
    let e164;
    try { e164 = normalizePhone(l.phone, country); } catch { invalid.push({ id: l.id, lead_number: l.lead_number, phone: l.phone, source: l.source }); continue; }
    if (e164 !== l.phone) reformat.push({ id: l.id, from: l.phone, to: e164 });
    if (!groups.has(e164)) groups.set(e164, []);
    groups.get(e164).push(l);
  }
  return { duplicates: [...groups.entries()].filter(([, g]) => g.length > 1), reformat, invalid };
};

async function run() {
  const tenants = (await query(`SELECT id, name, settings FROM tenants ${opt('--tenant') ? 'WHERE id = $1' : ''} ORDER BY name`, opt('--tenant') ? [opt('--tenant')] : [])).rows;
  const children = await childTables({ query });
  // Before the migration nothing can be merged yet, so the dry run simply doesn't filter.
  const migrated = (await query("SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'merged_into_id'")).rows.length > 0;
  if (apply && !migrated) throw new Error('Run models/migration_batch1_leads_merge.sql before --apply.');
  const live = migrated ? 'AND merged_into_id IS NULL' : '';
  const report = { mode: apply ? 'apply' : 'dry-run', at: new Date().toISOString(), tenants: [] };

  for (const t of tenants) {
    const { country } = localeFromSettings(t.settings || {});
    const leads = (await query(`SELECT * FROM leads WHERE tenant_id = $1 ${live} ORDER BY created_at, id`, [t.id])).rows;
    const { duplicates, reformat, invalid } = analyseTenant(leads, country);
    const tr = { tenant_id: t.id, tenant: t.name, country, leads: leads.length, duplicate_groups: duplicates.length,
      leads_to_merge: duplicates.reduce((s, [, g]) => s + g.length - 1, 0), phones_to_reformat: reformat.length, invalid_phones: invalid.length,
      stage_changes: 0, owner_changes: 0, rows_to_move: {}, groups: [], invalid, errors: [] };

    const mergedIds = duplicates.flatMap(([, g]) => g.slice(1).map(l => l.id));
    if (mergedIds.length) {
      for (const c of children) {
        const n = (await query(`SELECT count(*)::int n FROM "${c.table_name}" WHERE "${c.column_name}" = ANY($1::uuid[])`, [mergedIds])).rows[0].n;
        if (n) tr.rows_to_move[c.table_name] = n;
      }
    }

    for (const [phone, group] of duplicates) {
      const ctx = await loadContext({ query }, t.id, group.map(l => l.id));
      const plan = planMerge(group, ctx);
      if (plan.patch.stage !== undefined) tr.stage_changes++;
      if (plan.patch.assigned_to !== undefined) tr.owner_changes++;
      tr.groups.push({ phone, keep: plan.keepId, merge: plan.mergedIds, field_changes: plan.fieldChanges, other_touches: plan.otherTouches });
      if (!apply) continue;
      try {
        await transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`lead-ingestion:${t.id}`]);
          const locked = (await client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND merged_into_id IS NULL FOR UPDATE', [t.id, group.map(l => l.id)])).rows;
          if (locked.length !== group.length) throw new Error('group changed since it was read — skipped; rerun the script');
          await applyMerge(client, { tenantId: t.id, leads: locked, reason: 'phone_backfill', ctx: await loadContext(client, t.id, group.map(l => l.id)) });
        });
      } catch (e) { tr.errors.push({ phone, error: e.message }); }
    }

    if (apply) {
      for (const r of reformat) {
        await query('UPDATE leads SET phone = $3 WHERE tenant_id = $1 AND id = $2 AND phone = $4 AND merged_into_id IS NULL', [t.id, r.id, r.to, r.from])
          .catch(e => tr.errors.push({ id: r.id, error: e.message }));
      }
    }
    report.tenants.push(tr);
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'} ${t.name} (${country}): ${tr.leads} leads · ${tr.duplicate_groups} duplicate groups · ${tr.leads_to_merge} to merge · ${tr.phones_to_reformat} to reformat · ${tr.invalid_phones} invalid · stage changes ${tr.stage_changes} · owner changes ${tr.owner_changes}${tr.errors.length ? ` · ${tr.errors.length} errors` : ''}`);
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const sum = (k) => report.tenants.reduce((s, t) => s + t[k], 0);
  console.log(`\nTOTAL: ${sum('duplicate_groups')} groups, ${sum('leads_to_merge')} leads to merge, ${sum('phones_to_reformat')} phones to reformat, ${sum('invalid_phones')} invalid. Report: ${reportPath}`);
}

if (require.main === module) run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { analyseTenant };
