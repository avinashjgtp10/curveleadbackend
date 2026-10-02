const { ingestLead } = require('../services/leadIngestion');
const { mapMetaFields } = require('./metaFieldData');
const { query } = require('../config/db');
const { nextLeadNumber } = require('./leadNumber');
const { formatFieldDataNotes } = require('./metaFieldData');
const { sendWelcomeMessage } = require('./whatsappAutoResponder');
const { checkNewLeadTriggers } = require('./automationTriggers');
const { applyAssignmentRules } = require('./leadAssignment');
const { notifyNewLead } = require('./leadNotifyEmail');
const { notifyNewLeadToAdmins } = require('../controllers/notificationController');
const { findOrCreateMetaCampaign } = require('./metaCampaignMatch');
const { isMetaLeadDeleted } = require('./deletedLeads');

const { GRAPH_URL: GRAPH } = require('../config/meta');

// A lead older than this is imported and assigned but NOT messaged: the first sync
// after this shipped could otherwise pull in a backlog of old, never-imported leads
// and blast them all with the welcome message / automation sequences at once.
const FRESH_LEAD_WINDOW_MS = 2 * 60 * 60 * 1000;

const fbGet = async (path) => {
  const res = await fetch(`${GRAPH}${path}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
};

// Pulls new Meta Lead Ads leads for one tenant and runs the same post-creation
// pipeline as the real-time webhook (assignment rules, notifications, welcome
// message, automation triggers). Shared by the manual Sync button and the
// background job, so leads don't depend on someone opening the app.
const syncFacebookLeadsForTenant = async (tenantId) => {
  const result = await query('SELECT name, settings FROM tenants WHERE id = $1', [tenantId]);
  const tenantName = result.rows[0]?.name;
  const settings = result.rows[0]?.settings || {};
  const { meta_page_id, meta_page_access_token } = settings;
  if (!meta_page_id || !meta_page_access_token) {
    const err = new Error('Connect a Facebook page first.');
    err.code = 'NO_PAGE';
    throw err;
  }

  const formsData = await fbGet(
    `/${meta_page_id}/leadgen_forms?access_token=${encodeURIComponent(meta_page_access_token)}&limit=20&fields=id,name`
  );

  let created = 0, skipped = 0;

  for (const form of formsData.data || []) {
    const leadsData = await fbGet(
      `/${form.id}/leads?access_token=${encodeURIComponent(meta_page_access_token)}&limit=100`
      + `&fields=id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,platform`
    );

    for (const lead of leadsData.data || []) {
      const dup = await query('SELECT id FROM leads WHERE tenant_id = $1 AND meta_lead_id = $2', [tenantId, lead.id]);
      if (dup.rows.length) { skipped++; continue; }
      if (await isMetaLeadDeleted(tenantId, lead.id)) { skipped++; continue; }

      const fields = {};
      for (const f of lead.field_data || []) fields[f.name] = f.values?.[0] || '';

      const name = fields['full_name'] || fields['name'] || 'Unknown';
      const phone = fields['phone_number'] || fields['phone'] || null;
      const email = fields['email'] || null;
      const notes = formatFieldDataNotes(lead.field_data, {
        platform: lead.platform, tenantName,
        campaignName: lead.campaign_name, adsetName: lead.adset_name, adName: lead.ad_name,
      });

      const campaignId = await findOrCreateMetaCampaign({
        tenantId, campaignId: lead.campaign_id, campaignName: lead.campaign_name, adsetId: lead.adset_id,
      });

      let ingestion;
      try {
        ingestion = await ingestLead(tenantId, {
          name, phone, email, source: 'meta_ads', source_detail: lead.ad_name || form.name,
          campaign_id: campaignId || null, meta_lead_id: lead.id, meta_ad_id: lead.ad_id || null,
          meta_adset_id: lead.adset_id || null, stage: 'new', created_at: new Date(lead.created_time), notes,
          ...mapMetaFields(lead.field_data),
        });
      } catch (error) {
        if (error.status !== 422) throw error;
        console.warn('Invalid Meta lead phone; skipped submission', lead.id);
        skipped++; continue;
      }
      const inserted = ingestion.lead;
      if (ingestion.duplicate) { skipped++; continue; }

      const isFresh = Date.now() - new Date(lead.created_time).getTime() < FRESH_LEAD_WINDOW_MS;
      if (isFresh) sendWelcomeMessage({ tenantId, lead: inserted }).catch(() => {});
      applyAssignmentRules({ tenantId, lead: inserted })
        .then(() => notifyNewLead({ tenantId, lead: inserted }))
        .catch(() => {});
      if (isFresh) checkNewLeadTriggers({ tenantId, lead: inserted }).catch(() => {});
      notifyNewLeadToAdmins(tenantId, inserted).catch(() => {});
      created++;
    }
  }

  const last_synced_at = new Date().toISOString();
  await query(`UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('meta_leads_last_synced_at', $2::text) WHERE id=$1`, [tenantId,last_synced_at]);
  return { created, skipped, last_synced_at };
};

module.exports = { syncFacebookLeadsForTenant };
