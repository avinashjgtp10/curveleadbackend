const { query } = require('../config/db');
const { graphRequest, graphPaged } = require('../utils/metaGraph');
const { ingestLead } = require('./leadIngestion');
const { mapMetaFields, formatFieldDataNotes } = require('../utils/metaFieldData');
const { sendWelcomeMessage } = require('../utils/whatsappAutoResponder');
const { checkNewLeadTriggers } = require('../utils/automationTriggers');
const { applyAssignmentRules } = require('../utils/leadAssignment');
const { notifyNewLead } = require('../utils/leadNotifyEmail');
const { notifyNewLeadToAdmins } = require('../controllers/notificationController');
const { findOrCreateMetaCampaign } = require('../utils/metaCampaignMatch');
const { isMetaLeadDeleted } = require('../utils/deletedLeads');
const { scoreAndSaveLead } = require('./leadScoring');

// Meta Lead Ads → CRM leads. One pipeline for the real-time webhook (via the
// leads:ingest-meta job), the 30-minute safety poll and per-form backfills.

const LEAD_FIELDS = 'id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,form_id,platform,is_organic';
// Older leads are imported and assigned but not messaged: a backfill must not blast a
// backlog of old leads with welcome messages and automation sequences.
const FRESH_LEAD_WINDOW_MS = 2 * 60 * 60 * 1000;

const noPage = () => Object.assign(new Error('Connect a Facebook page first.'), { code: 'NO_PAGE', status: 400 });

const pageContext = async (tenantId) => {
  const { rows } = await query('SELECT name, settings FROM tenants WHERE id = $1', [tenantId]);
  const s = rows[0]?.settings || {};
  if (!s.meta_page_id || !s.meta_page_access_token) throw noPage();
  return {
    tenantId, tenantName: rows[0].name, pageId: String(s.meta_page_id), pageToken: s.meta_page_access_token,
    scoreOnIngest: s.meta_lead_score_on_ingest !== false,
  };
};

const tenantForPage = async (pageId) => {
  if (!pageId) return null;
  const { rows } = await query(`SELECT id FROM tenants WHERE settings->>'meta_page_id' = $1 LIMIT 1`, [String(pageId)]);
  return rows[0]?.id || null;
};

const fieldsOf = (lead) => {
  const f = {};
  for (const x of lead.field_data || []) f[x.name] = x.values?.[0] || '';
  return f;
};

// Creates the CRM lead for one Meta lead and runs the post-creation pipeline.
// Returns 'created' | 'duplicate' | 'skipped'.
const processMetaLead = async (ctx, lead, { formName } = {}) => {
  const { tenantId } = ctx;
  if (await isMetaLeadDeleted(tenantId, lead.id)) return 'skipped';
  const f = fieldsOf(lead);
  const phone = f.phone_number || f.phone || '';
  if (!phone) { console.warn(`Meta lead ${lead.id} has no phone; skipped`); return 'skipped'; }
  const name = f.full_name || f.name || `${f.first_name || ''} ${f.last_name || ''}`.trim() || 'Unknown';

  const campaignId = await findOrCreateMetaCampaign({ tenantId, campaignId: lead.campaign_id, campaignName: lead.campaign_name, adsetId: lead.adset_id });
  let ingestion;
  try {
    ingestion = await ingestLead(tenantId, {
      name, phone, email: f.email || null, source: 'meta_ads',
      source_detail: lead.ad_name || formName || (lead.ad_id ? `Ad: ${lead.ad_id}` : 'Meta lead form'),
      campaign_id: campaignId || null, meta_lead_id: lead.id, meta_ad_id: lead.ad_id || null,
      meta_adset_id: lead.adset_id || null, meta_form_id: lead.form_id || null, stage: 'new',
      ...(lead.created_time ? { created_at: new Date(lead.created_time) } : {}),
      notes: formatFieldDataNotes(lead.field_data, {
        platform: lead.platform, tenantName: ctx.tenantName,
        campaignName: lead.campaign_name, adsetName: lead.adset_name, adName: lead.ad_name,
      }),
      ...mapMetaFields(lead.field_data),
    });
  } catch (e) {
    if (e.status !== 422) throw e;
    console.warn(`Meta lead ${lead.id} has an invalid phone; skipped`);
    return 'skipped';
  }
  if (ingestion.duplicate) return 'duplicate';

  const inserted = ingestion.lead;
  const fresh = !lead.created_time || Date.now() - new Date(lead.created_time).getTime() < FRESH_LEAD_WINDOW_MS;
  if (ctx.scoreOnIngest) await scoreAndSaveLead(inserted, tenantId).catch(e => console.error('Meta lead scoring failed:', lead.id, e.message));
  if (fresh) sendWelcomeMessage({ tenantId, lead: inserted }).catch(() => {});
  applyAssignmentRules({ tenantId, lead: inserted }).then(() => notifyNewLead({ tenantId, lead: inserted })).catch(() => {});
  if (fresh) checkNewLeadTriggers({ tenantId, lead: inserted }).catch(() => {});
  notifyNewLeadToAdmins(tenantId, inserted).catch(() => {});
  return 'created';
};

// Imports a list of Meta leads, skipping ones already in the CRM in one query.
const processLeads = async (ctx, leads, opts) => {
  const counts = { created: 0, duplicate: 0, skipped: 0 };
  if (!leads.length) return counts;
  const { rows } = await query('SELECT meta_lead_id FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL AND meta_lead_id = ANY($2::text[])', [ctx.tenantId, leads.map(l => String(l.id))]);
  const known = new Set(rows.map(r => r.meta_lead_id));
  for (const lead of leads) {
    if (known.has(String(lead.id))) { counts.duplicate++; continue; }
    counts[await processMetaLead(ctx, lead, opts)]++;
  }
  return counts;
};

// leads:ingest-meta job — one lead announced by the webhook.
const ingestWebhookLead = async ({ pageId, leadgenId }) => {
  const tenantId = await tenantForPage(pageId);
  if (!tenantId) return { skipped: 'unknown_page' };
  const ctx = await pageContext(tenantId);
  const { rows } = await query('SELECT id FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL AND meta_lead_id = $2', [tenantId, String(leadgenId)]);
  if (rows[0]) return { result: 'duplicate' };
  const lead = await graphRequest({ path: `/${leadgenId}`, token: ctx.pageToken, gateKey: `page:${ctx.pageId}`, params: { fields: LEAD_FIELDS }, retries: 3 });
  return { result: await processMetaLead(ctx, lead) };
};

const leadsOfForm = (ctx, formId, sinceUnix) => graphPaged({
  path: `/${formId}/leads`, token: ctx.pageToken, gateKey: `page:${ctx.pageId}`,
  params: {
    fields: LEAD_FIELDS, limit: 100,
    ...(sinceUnix ? { filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }]) } : {}),
  },
}, 1000);

const fetchForms = (ctx) => graphPaged({
  path: `/${ctx.pageId}/leadgen_forms`, token: ctx.pageToken, gateKey: `page:${ctx.pageId}`,
  params: { fields: 'id,name,status,leads_count,created_time', limit: 100 },
});

// Refreshes the workspace's lead forms from its Facebook Page and returns them.
const listForms = async (tenantId) => {
  const ctx = await pageContext(tenantId);
  for (const f of await fetchForms(ctx)) {
    await query(
      `INSERT INTO ad_lead_forms (tenant_id, page_id, external_id, name, status, leads_count, created_time, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (tenant_id, external_id) DO UPDATE SET page_id = EXCLUDED.page_id, name = EXCLUDED.name, status = EXCLUDED.status,
         leads_count = EXCLUDED.leads_count, created_time = EXCLUDED.created_time, synced_at = now()`,
      [tenantId, ctx.pageId, String(f.id), f.name || null, f.status || null, f.leads_count ?? null, f.created_time || null]
    );
  }
  const { rows } = await query(
    `SELECT f.id, f.external_id, f.name, f.status, f.leads_count, f.created_time, f.last_backfilled_at, f.last_backfill_count, f.last_backfill_error,
            (SELECT count(*)::int FROM leads l WHERE l.tenant_id = f.tenant_id AND l.merged_into_id IS NULL AND l.meta_form_id = f.external_id) AS crm_leads
     FROM ad_lead_forms f WHERE f.tenant_id = $1 AND f.page_id = $2 ORDER BY f.created_time DESC NULLS LAST, f.name`,
    [tenantId, ctx.pageId]
  );
  return { page_id: ctx.pageId, score_on_ingest: ctx.scoreOnIngest, forms: rows };
};

// leads:backfill-form job — every lead of one form (optionally since a date).
const backfillForm = async ({ tenantId, formId, since }) => {
  const { rows } = await query('SELECT external_id, name FROM ad_lead_forms WHERE tenant_id = $1 AND id = $2', [tenantId, formId]);
  const form = rows[0];
  if (!form) return { skipped: 'not_found' };
  try {
    const ctx = await pageContext(tenantId);
    const sinceUnix = since ? Math.floor(new Date(`${since}T00:00:00Z`).getTime() / 1000) : null;
    const counts = await processLeads(ctx, await leadsOfForm(ctx, form.external_id, sinceUnix), { formName: form.name });
    await query(`UPDATE ad_lead_forms SET last_backfilled_at = now(), last_backfill_count = $3, last_backfill_error = NULL WHERE tenant_id = $1 AND id = $2`,
      [tenantId, formId, counts.created]);
    return counts;
  } catch (e) {
    await query('UPDATE ad_lead_forms SET last_backfill_error = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, formId, String(e.message).slice(0, 500)]);
    throw e;
  }
};

// Safety net for missed webhooks: leads created in the last `hours` on every form.
const pollRecentLeads = async (tenantId, hours = 24) => {
  const ctx = await pageContext(tenantId);
  const sinceUnix = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  const total = { created: 0, duplicate: 0, skipped: 0 };
  for (const form of await fetchForms(ctx)) {
    const counts = await processLeads(ctx, await leadsOfForm(ctx, form.id, sinceUnix), { formName: form.name });
    for (const k of Object.keys(total)) total[k] += counts[k];
  }
  return total;
};

module.exports = {
  LEAD_FIELDS, FRESH_LEAD_WINDOW_MS, pageContext, tenantForPage, processMetaLead, processLeads,
  ingestWebhookLead, listForms, backfillForm, pollRecentLeads,
};
