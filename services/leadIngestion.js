const { assignInTransaction } = require('../utils/leadAssignment');
const { transaction } = require('../config/db');
const { nextLeadNumber } = require('../utils/leadNumber');
const { normalizeLead, normalizePhone } = require('../utils/dataQuality');
const COLUMNS = new Set(['product','is_test_lead','gclid','lead_submit_time','google_custom_answers','google_ads_integration_id','name','phone','email','location','business_name','address','city','custom_fields','source','source_detail','campaign_id','stage','assigned_to','notes','deal_value','expected_close_date','tags','lead_date','meta_lead_id','meta_ad_id','meta_adset_id','created_at','google_lead_id','google_form_id','google_campaign_id','google_adgroup_id','google_creative_id','google_asset_group_id','google_gcl_id','google_is_test','google_integration_id']);
async function ingestLead(tenantId, input, { submissionKey = input.meta_lead_id ? `meta:${input.meta_lead_id}` : null, actorId = null } = {}) {
  const data = normalizeLead(input);
  return transaction(async client => {
    // Serialize workspace ingestion, including email matching, to prevent concurrent duplicates.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`lead-ingestion:${tenantId}`]);
    if (submissionKey) {
      const seen = await client.query('SELECT l.* FROM lead_submissions s JOIN leads l ON l.id=s.lead_id AND l.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.submission_key=$2', [tenantId, submissionKey]);
      if (seen.rows[0]) return { lead: seen.rows[0], duplicate: true };
    }
    // Provider IDs created before lead_submissions existed must also be idempotent.
    for (const key of ['meta_lead_id', 'google_lead_id']) {
      if (!data[key]) continue;
      const seen = await client.query(`SELECT * FROM leads WHERE tenant_id=$1 AND ${key}=$2 LIMIT 1`, [tenantId,data[key]]);
      if (seen.rows[0]) return { lead: seen.rows[0], duplicate: true };
    }
    const settings = await client.query('SELECT settings FROM tenants WHERE id=$1', [tenantId]);
    const mode = settings.rows[0]?.settings?.dedupe_mode || 'phone';
    let existing;
    if (mode !== 'off') {
      // Include legacy variants until the explicit backfill has been applied.
      const candidates = await client.query(`SELECT * FROM leads WHERE tenant_id=$1 AND
        (regexp_replace(phone, '[^0-9]', '', 'g') = ANY($2::text[])
        OR ($3::boolean AND NULLIF(LOWER(TRIM(email)), '') = $4)) ORDER BY created_at, id FOR UPDATE`,
      [tenantId, [data.phone.slice(1), ...(data.phone.startsWith('+91') ? [data.phone.slice(3), '0' + data.phone.slice(3)] : [])], mode === 'phone_or_email', data.email]);
      existing = candidates.rows.find(row => {
        try { if (normalizePhone(row.phone) === data.phone) return true; } catch {}
        return mode === 'phone_or_email' && data.email && row.email?.trim().toLowerCase() === data.email;
      });
    }
    let lead = existing;
    if (!lead) {
      const number = await nextLeadNumber(tenantId, client);
      const entries = Object.entries(data).filter(([key, value]) => COLUMNS.has(key) && value !== undefined);
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
