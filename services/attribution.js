// Lead attribution reads and audited corrections. Capture itself happens in the database (migration_phase1_attribution.sql):
// the ORIGINAL attribution can never change, a correction changes only the EFFECTIVE campaign, always with a reason, and
// keeps leads.campaign_id (the legacy field every screen still reads) in step in the same transaction.
const { query, transaction } = require('../config/db');

class AttributionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const tableExists = async () => (await query(`SELECT to_regclass('lead_attribution') IS NOT NULL AS present`)).rows[0].present;
const requireTable = async () => { if (!(await tableExists())) throw new AttributionError(503, 'attribution_unavailable', 'Attribution is not set up in this database yet.'); };
const reasonOf = (v) => { const r = String(v == null ? '' : v).trim(); if (r.length < 3) throw new AttributionError(422, 'reason_required', 'A reason is required.'); return r.slice(0, 500); };

const ORIGINAL_FIELDS = ['source', 'source_detail', 'crm_campaign_id', 'meta_lead_id', 'meta_ad_id', 'meta_adset_id', 'meta_form_id', 'google_lead_id', 'google_campaign_id', 'google_adgroup_id', 'google_creative_id', 'gclid'];

const getAttribution = async ({ tenantId, leadId }) => {
  await requireTable();
  const a = (await query('SELECT * FROM lead_attribution WHERE tenant_id = $1 AND lead_id = $2', [tenantId, leadId])).rows[0];
  if (!a) {
    const lead = (await query('SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, tenantId])).rows[0];
    if (!lead) throw new AttributionError(404, 'lead_not_found', 'Lead not found.');
    return { lead_id: leadId, recorded: false, status: 'unattributed', note: 'No attribution record yet (the lead pre-dates attribution capture; run the attribution backfill).' };
  }
  const events = (await query('SELECT id, event, before, after, reason, actor, created_at FROM lead_attribution_events WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at, id', [tenantId, leadId])).rows;
  const names = (await query('SELECT id, name FROM campaigns WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, [a.original_crm_campaign_id, a.effective_crm_campaign_id].filter(Boolean)])).rows;
  const nameOf = (id) => (names.find((n) => n.id === id) || {}).name || null;
  return {
    lead_id: leadId, recorded: true, status: a.status, capture_basis: a.capture_basis,
    original: Object.fromEntries(ORIGINAL_FIELDS.map((f) => [f, a[`original_${f}`]])),
    original_campaign_name: nameOf(a.original_crm_campaign_id),
    effective: { crm_campaign_id: a.effective_crm_campaign_id, campaign_name: nameOf(a.effective_crm_campaign_id) },
    corrected_at: a.corrected_at, correction_reason: a.correction_reason, events,
  };
};

// Correct the EFFECTIVE campaign (null = no campaign). The original stays as captured.
const correct = ({ tenantId, leadId, userId, crmCampaignId, reason }) => transaction(async (c) => {
  await requireTable();
  const why = reasonOf(reason);
  const lead = (await c.query('SELECT id, campaign_id, merged_into_id FROM leads WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [leadId, tenantId])).rows[0];
  if (!lead) throw new AttributionError(404, 'lead_not_found', 'Lead not found.');
  if (lead.merged_into_id) throw new AttributionError(409, 'lead_merged', 'This lead was merged into another lead; correct the surviving lead.');
  if (crmCampaignId) {
    const camp = (await c.query('SELECT 1 FROM campaigns WHERE id = $1 AND tenant_id = $2', [crmCampaignId, tenantId])).rows[0];
    if (!camp) throw new AttributionError(422, 'campaign_not_found', 'That campaign does not exist in this workspace.');
  }
  await c.query(`SELECT set_config('curvelead.attribution_correction', 'on', true)`); // the trigger must not log this change a second time
  let a = (await c.query('SELECT * FROM lead_attribution WHERE lead_id = $1 FOR UPDATE', [leadId])).rows[0];
  if (!a) {
    await c.query(`INSERT INTO lead_attribution (lead_id, tenant_id, status, capture_basis, original_crm_campaign_id, effective_crm_campaign_id) VALUES ($1,$2,$3,'backfill',$4,$4)`,
      [leadId, tenantId, lead.campaign_id ? 'inferred' : 'unattributed', lead.campaign_id]);
    a = (await c.query('SELECT * FROM lead_attribution WHERE lead_id = $1', [leadId])).rows[0];
  }
  await c.query(`UPDATE lead_attribution SET effective_crm_campaign_id = $2, status = 'manual', corrected_at = now(), corrected_by = $3, correction_reason = $4 WHERE lead_id = $1`,
    [leadId, crmCampaignId || null, userId || null, why]);
  await c.query(`INSERT INTO lead_attribution_events (tenant_id, lead_id, event, before, after, reason, actor) VALUES ($1,$2,'corrected',$3,$4,$5,$6)`,
    [tenantId, leadId, JSON.stringify({ crm_campaign_id: a.effective_crm_campaign_id }), JSON.stringify({ crm_campaign_id: crmCampaignId || null }), why, userId || null]);
  await c.query('UPDATE leads SET campaign_id = $2 WHERE id = $1', [leadId, crmCampaignId || null]);
  return getAttributionIn(c, tenantId, leadId);
});
const getAttributionIn = async (c, tenantId, leadId) => {
  const a = (await c.query('SELECT status, effective_crm_campaign_id, corrected_at, correction_reason FROM lead_attribution WHERE lead_id = $1 AND tenant_id = $2', [leadId, tenantId])).rows[0];
  return { lead_id: leadId, status: a.status, effective: { crm_campaign_id: a.effective_crm_campaign_id }, corrected_at: a.corrected_at, correction_reason: a.correction_reason };
};

module.exports = { AttributionError, getAttribution, correct, tableExists };
