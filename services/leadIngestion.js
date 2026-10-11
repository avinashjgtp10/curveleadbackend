const { assignInTransaction } = require('../utils/leadAssignment');
const { transaction } = require('../config/db');
const { nextLeadNumber } = require('../utils/leadNumber');
const { normalizeLead, normalizePhone, phoneDigitVariants } = require('../utils/dataQuality');
const { localeFromSettings } = require('../utils/workspaceLocale');
const COLUMNS = new Set(['product','is_test_lead','gclid','lead_submit_time','google_custom_answers','google_ads_integration_id','name','phone','email','location','business_name','address','city','custom_fields','source','source_detail','campaign_id','stage','assigned_to','notes','deal_value','expected_close_date','tags','lead_date','meta_lead_id','meta_ad_id','meta_adset_id','meta_form_id','whatsapp_opt_in_at','whatsapp_opt_in_source','created_at','google_lead_id','google_form_id','google_campaign_id','google_adgroup_id','google_creative_id','google_asset_group_id','google_gcl_id','google_is_test','google_integration_id']);
// Columns added by later migrations: written only once the column exists, so lead capture
// keeps working if the code is deployed before the migration (checked every 5 minutes).
const OPTIONAL_COLUMNS = ['meta_form_id'];
let presentOptional = { at: 0, set: new Set() };
async function optionalColumns(client) {
  if (Date.now() - presentOptional.at < 5 * 60 * 1000) return presentOptional.set;
  const r = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' AND column_name = ANY($1::text[])`, [OPTIONAL_COLUMNS]);
  presentOptional = { at: Date.now(), set: new Set(r.rows.map(x => x.column_name)) };
  return presentOptional.set;
}

// A lead that was merged into another resolves to the lead it was merged into.
async function survivor(client, lead) {
  for (let hops = 0; lead?.merged_into_id && hops < 5; hops++) {
    lead = (await client.query('SELECT * FROM leads WHERE id=$1', [lead.merged_into_id])).rows[0] || lead;
  }
  return lead;
}

// Options:
//   rejectDuplicate - a person is adding the lead by hand: if the number already exists return that lead
//                     untouched ({ duplicate: true }) so the caller can refuse, instead of recording another
//                     "duplicate received" activity on it (that is what imports/webhooks want).
//   phoneOnly       - never match on email, whatever the workspace's dedupe_mode says.
async function ingestLead(tenantId, input, {
  submissionKey = input.meta_lead_id ? `meta:${input.meta_lead_id}` : null, actorId = null, rejectDuplicate = false, phoneOnly = false,
} = {}) {
  return transaction(async client => {
    const settings = await client.query('SELECT settings FROM tenants WHERE id=$1', [tenantId]);
    // Phones without a country code are read in the workspace's country.
    const data = normalizeLead(input, localeFromSettings(settings.rows[0]?.settings).country);
    // Serialize workspace ingestion, including email matching, to prevent concurrent duplicates.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`lead-ingestion:${tenantId}`]);
    if (submissionKey) {
      const seen = await client.query('SELECT l.* FROM lead_submissions s JOIN leads l ON l.id=s.lead_id AND l.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.submission_key=$2', [tenantId, submissionKey]);
      if (seen.rows[0]) return { lead: await survivor(client, seen.rows[0]), duplicate: true };
    }
    // Provider IDs created before lead_submissions existed must also be idempotent.
    for (const key of ['meta_lead_id', 'google_lead_id']) {
      if (!data[key]) continue;
      const seen = await client.query(`SELECT * FROM leads WHERE tenant_id=$1 AND ${key}=$2 LIMIT 1`, [tenantId,data[key]]);
      if (seen.rows[0]) return { lead: await survivor(client, seen.rows[0]), duplicate: true };
    }
    const mode = settings.rows[0]?.settings?.dedupe_mode || 'phone';
    const matchEmail = mode === 'phone_or_email' && !phoneOnly;
    let existing;
    if (mode !== 'off') {
      // Match every stored format of the number (legacy rows may not be E.164 yet); merged leads never match.
      const country = localeFromSettings(settings.rows[0]?.settings).country;
      const candidates = await client.query(`SELECT * FROM leads WHERE tenant_id=$1 AND merged_into_id IS NULL AND
        (regexp_replace(phone, '[^0-9]', '', 'g') = ANY($2::text[])
        OR ($3::boolean AND NULLIF(LOWER(TRIM(email)), '') = $4)) ORDER BY created_at, id FOR UPDATE`,
      [tenantId, phoneDigitVariants(data.phone), matchEmail, data.email]);
      existing = candidates.rows.find(row => {
        try { if (normalizePhone(row.phone, country) === data.phone) return true; } catch {}
        return matchEmail && data.email && row.email?.trim().toLowerCase() === data.email;
      });
    }
    if (existing && rejectDuplicate) return { lead: existing, duplicate: true };
    let lead = existing;
    if (!lead) {
      const number = await nextLeadNumber(tenantId, client);
      const optional = await optionalColumns(client);
      const entries = Object.entries(data).filter(([key, value]) => COLUMNS.has(key) && value !== undefined
        && (!OPTIONAL_COLUMNS.includes(key) || optional.has(key)));
      const result = await client.query(`INSERT INTO leads (tenant_id, lead_number, ${entries.map(([k]) => k).join(',')}) VALUES ($1,$2,${entries.map((_, i) => '$' + (i + 3)).join(',')}) RETURNING *`,
        [tenantId, number, ...entries.map(([key, value]) => key === 'custom_fields' ? JSON.stringify(value) : value)]);
      lead = await assignInTransaction(client, tenantId, result.rows[0]);
      // Workspace choice (Settings): treat an enquiry as consent to WhatsApp contact. Off unless the
      // owner turns it on. Recorded with its own source so implied opt-ins stay distinguishable
      // from explicit ones, and it never overrides an opt-out or an existing opt-in.
      if (settings.rows[0]?.settings?.whatsapp_auto_opt_in === true && !lead.whatsapp_opt_in_at && !lead.opted_out) {
        const opted = await client.query(`UPDATE leads SET whatsapp_opt_in_at = NOW(), whatsapp_opt_in_source = 'enquiry_auto' WHERE id=$1 AND tenant_id=$2 AND whatsapp_opt_in_at IS NULL AND opted_out = false RETURNING *`, [lead.id, tenantId]);
        if (opted.rows[0]) lead = opted.rows[0];
      }
    } else {
      await client.query(`INSERT INTO lead_activities (tenant_id,lead_id,activity_type,title,description,metadata,created_by) VALUES ($1,$2,'duplicate',$3,$4,$5,$6)`,
        [tenantId, lead.id, `Duplicate lead received from ${data.source}`, data.notes || null, JSON.stringify({ submission: data }), actorId]);
    }
    if (submissionKey) await client.query('INSERT INTO lead_submissions (tenant_id,submission_key,lead_id) VALUES ($1,$2,$3)', [tenantId, submissionKey, lead.id]);
    return { lead, duplicate: !!existing };
  });
}
// Read-only: the live (not merged) lead in this workspace that already holds this number, in any stored
// format, or undefined. `db` is anything with query(sql, params). Matches the phone number only.
async function findLeadByPhone(db, tenantId, e164, country) {
  const candidates = await db.query(`SELECT * FROM leads WHERE tenant_id=$1 AND merged_into_id IS NULL AND
    regexp_replace(phone, '[^0-9]', '', 'g') = ANY($2::text[]) ORDER BY created_at, id`, [tenantId, phoneDigitVariants(e164)]);
  return candidates.rows.find(row => { try { return normalizePhone(row.phone, country) === e164; } catch { return false; } });
}
module.exports = { ingestLead, findLeadByPhone };
