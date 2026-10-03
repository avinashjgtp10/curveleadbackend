// Batch 1 (C): record WhatsApp opt-ins for existing Meta lead-form leads whose form had a
// consent checkbox (custom disclaimer) that the lead ticked. Source "meta_lead_form",
// timestamp = when the lead submitted the form. Reads Meta (read-only); writes only with --apply.
//
//   node scripts/backfillMetaOptIns.js            dry run: counts per workspace and form
//   node scripts/backfillMetaOptIns.js --apply    record the opt-ins
//   options: --tenant <uuid>
//
// Never overrides an existing opt-in, never touches opted-out leads; merged duplicates
// resolve to the lead they were merged into.
require('dotenv').config();
const { query, pool } = require('../config/db');
const { graphPaged } = require('../utils/metaGraph');
const { formConsent } = require('../services/metaLeads');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArg = (() => { const i = args.indexOf('--tenant'); return i >= 0 ? args[i + 1] : null; })();

// A form "had consent" when its legal content includes at least one checkbox.
const consentCheckboxes = (form) => form?.legal_content?.custom_disclaimer?.checkboxes?.data || form?.legal_content?.custom_disclaimer?.checkboxes || [];

async function run() {
  const tenants = (await query(
    `SELECT id, name, settings->>'meta_page_id' AS page_id, settings->>'meta_page_access_token' AS token FROM tenants
     WHERE settings->>'meta_page_id' IS NOT NULL AND settings->>'meta_page_access_token' IS NOT NULL ${tenantArg ? 'AND id = $1' : ''}`,
    tenantArg ? [tenantArg] : [])).rows;
  const hasMerge = (await query("SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'merged_into_id'")).rows.length > 0;
  let total = 0;

  for (const t of tenants) {
    let forms;
    try {
      forms = await graphPaged({ path: `/${t.page_id}/leadgen_forms`, token: t.token, gateKey: `page:${t.page_id}`,
        params: { fields: 'id,name,status,legal_content{custom_disclaimer{title,checkboxes{key,text,is_required}}}', limit: 100 } });
    } catch (e) { console.log(`${t.name}: could not read forms — ${e.message}`); continue; }

    let tenantCount = 0;
    for (const form of forms.filter(f => consentCheckboxes(f).length)) {
      const required = consentCheckboxes(form).some(c => c.is_required);
      let leads;
      try {
        leads = await graphPaged({ path: `/${form.id}/leads`, token: t.token, gateKey: `page:${t.page_id}`,
          params: { fields: 'id,created_time,custom_disclaimer_responses', limit: 100 } }, 1000);
      } catch (e) { console.log(`  ${t.name} / ${form.name}: could not read leads — ${e.message}`); continue; }
      // A required checkbox means every submission agreed; otherwise only ticked responses count.
      const consented = leads.filter(l => required || formConsent(l));
      if (!consented.length) continue;

      const byMetaId = new Map(consented.map(l => [String(l.id), l.created_time]));
      const rows = (await query(
        `SELECT ${hasMerge ? 'COALESCE(l.merged_into_id, l.id)' : 'l.id'} AS lead_id, l.meta_lead_id
         FROM leads l WHERE l.tenant_id = $1 AND l.meta_lead_id = ANY($2::text[])`, [t.id, [...byMetaId.keys()]])).rows;
      const targets = (await query(
        'SELECT id FROM leads WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND whatsapp_opt_in_at IS NULL AND opted_out = false',
        [t.id, [...new Set(rows.map(r => r.lead_id))]])).rows.map(r => r.id);
      const at = new Map(rows.map(r => [r.lead_id, byMetaId.get(r.meta_lead_id)]));

      console.log(`  ${t.name} / ${form.name}: ${consented.length} consented on Meta · ${rows.length} in CurveLead · ${targets.length} to record${required ? ' (required checkbox)' : ''}`);
      tenantCount += targets.length;
      if (!apply) continue;
      for (const id of targets) {
        await query(
          `UPDATE leads SET whatsapp_opt_in_at = $3, whatsapp_opt_in_source = 'meta_lead_form'
           WHERE tenant_id = $1 AND id = $2 AND whatsapp_opt_in_at IS NULL AND opted_out = false`,
          [t.id, id, at.get(id) ? new Date(at.get(id)) : new Date()]);
      }
    }
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'} ${t.name}: ${tenantCount} lead(s) ${apply ? 'opted in' : 'would be opted in'}`);
    total += tenantCount;
  }
  console.log(`\nTOTAL: ${total} lead(s) ${apply ? 'opted in' : 'would be opted in'} (source meta_lead_form).`);
}

if (require.main === module) run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { consentCheckboxes };
