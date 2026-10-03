const { assignInTransaction } = require('../utils/leadAssignment');
const { transaction } = require('../config/db');
const { nextLeadNumber } = require('../utils/leadNumber');
const { normalizeLead, normalizePhone, phoneDigitVariants } = require('../utils/dataQuality');
const { localeFromSettings } = require('../utils/workspaceLocale');
const COLUMNS = new Set(['product','is_test_lead','gclid','lead_submit_time','google_custom_answers','google_ads_integration_id','name','phone','email','location','business_name','address','city','custom_fields','source','source_detail','campaign_id','stage','assigned_to','notes','deal_value','expected_close_date','tags','lead_date','meta_lead_id','meta_ad_id','meta_adset_id','meta_form_id','created_at','google_lead_id','google_form_id','google_campaign_id','google_adgroup_id','google_creative_id','google_asset_group_id','google_gcl_id','google_is_test','google_integration_id']);
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

async function ingestLead(tenantId, input, { submissionKey = input.meta_lead_id ? `meta:${input.meta_lead_id}` : null, actorId = null } = {}) {
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
    let existing;
    if (mode !== 'off') {
      // Match every stored format of the number (legacy rows may not be E.164 yet); merged leads never match.
      const country = localeFromSettings(settings.rows[0]?.settings).country;
      const candidates = await client.query(`SELECT * FROM leads WHERE tenant_id=$1 AND merged_into_id IS NULL AND
        (regexp_replace(phone, '[^0-9]', '', 'g') = ANY($2::text[])
        OR ($3::boolean AND NULLIF(LOWER(TRIM(email)), '') = $4)) ORDER BY created_at, id FOR UPDATE`,
      [tenantId, phoneDigitVariants(data.phone), mode === 'phone_or_email', data.email]);
      existing = candidates.rows.find(row => {
        try { if (normalizePhone(row.phone, country) === data.phone) return true; } catch {}
        return mode === 'phone_or_email' && data.email && row.email?.trim().toLowerCase() === data.email;
      });
    }
    let lead = existing;
    if (!lead) {
      const number = await nextLeadNumber(tenantId, client);
      const optional = await optionalColumns(client);
      const entries = Object.entries(data).filter(([key, value]) => COLUMNS.has(key) && value !== undefined
        && (!OPTIONAL_COLUMNS.includes(key) || optional.has(key)));
      const result = await client.query(`INSERT INTO leads (tenant_id, lead_number, ${entries.map(([k]) => k).join(',')}) VALUES ($1,$2,${entries.map((_, i) => '$' + (i + 3)).join(',')}) RETURNING *`,
        [tenantId, number, ...entries.map(([key, value]) => key === 'custom_fields' ? JSON.stringify(value) : value)]);
      lead = await assignInTransaction(client, tenantId, result.rows[0]);
    } else {
      await client.query(`INSERT INTO lead_activities (tenant_id,lead_id,activity_type,title,description,metadata,created_by) VALUES ($1,$2,'duplicate',$3,$4,$5,$6)`,
        [tenantId, lead.id, `Duplicate lead received from ${data.source}`, data.notes || null, JSON.stringify({ submission: data }), actorId]);
    }
    if (submissionKey) await client.query('INSERT INTO lead_submissions (tenant_id,submission_key,lead_id) VALUES ($1,$2,$3)', [tenantId, submissionKey, lead.id]);
    return { lead, duplicate: !!existing };
  });
}
module.exports = { ingestLead };
