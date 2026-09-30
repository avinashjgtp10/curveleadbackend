const { ingestLead } = require('../services/leadIngestion');
const { mapMetaFields } = require('../utils/metaFieldData');
const { query } = require('../config/db');
const { nextLeadNumber } = require('../utils/leadNumber');
const { formatFieldDataNotes } = require('../utils/metaFieldData');
const { sendWelcomeMessage } = require('../utils/whatsappAutoResponder');
const { checkNewLeadTriggers } = require('../utils/automationTriggers');
const { applyAssignmentRules } = require('../utils/leadAssignment');
const { notifyNewLead } = require('../utils/leadNotifyEmail');
const { notifyNewLeadToAdmins } = require('./notificationController');
const { findOrCreateMetaCampaign } = require('../utils/metaCampaignMatch');
const { isMetaLeadDeleted } = require('../utils/deletedLeads');
const axios = require('axios');

// GET /api/webhook/meta - Verify webhook
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

// POST /api/webhook/meta - Receive lead from Meta Ads
const receiveLeadFormWebhook = async (req, res) => {
  res.sendStatus(200); // Always respond 200 first

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes || [];

    for (const change of changes) {
      if (change.field !== 'leadgen') continue;

      const leadgenId = change.value.leadgen_id;
      const pageId = change.value.page_id;
      const adId = change.value.ad_id;

      // Find tenant by page_id and get their stored access token
      const tenantResult = await query(
        `SELECT id, name, settings->>'meta_page_access_token' AS page_access_token
         FROM tenants WHERE settings->>'meta_page_id' = $1 LIMIT 1`,
        [pageId]
      );
      const tenant = tenantResult.rows[0];
      if (!tenant) {
        console.warn(`No tenant found for Meta page ${pageId}`);
        continue;
      }

      if (!tenant.page_access_token) {
        console.warn(`Tenant ${tenant.id} has no page access token for page ${pageId}`);
        continue;
      }

      if (await isMetaLeadDeleted(tenant.id, leadgenId)) {
        console.log(`Meta lead ${leadgenId} was previously deleted, skipping`);
        continue;
      }

      // Fetch lead details using the tenant's page access token — including
      // campaign/adset/ad fields, which Meta returns directly here (verified
      // live) without needing any ads_read permission or extra API call.
      let leadData;
      try {
        const response = await axios.get(
          `https://graph.facebook.com/v25.0/${leadgenId}`,
          {
            params: {
              access_token: tenant.page_access_token,
              fields: 'field_data,ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,form_id,created_time,platform',
            },
          }
        );
        leadData = response.data;
      } catch (e) {
        console.error('Failed to fetch lead from Meta:', e.message);
        continue;
      }

      // Parse field data
      const fields = {};
      (leadData.field_data || []).forEach(f => {
        fields[f.name] = f.values?.[0];
      });

      const campaignId = await findOrCreateMetaCampaign({
        tenantId: tenant.id,
        campaignId: leadData.campaign_id,
        campaignName: leadData.campaign_name,
        adsetId: leadData.adset_id,
      });

      const phone = fields.phone_number || fields.phone || '';
      const name = fields.full_name || `${fields.first_name || ''} ${fields.last_name || ''}`.trim();
      const email = fields.email || '';

      if (!phone) {
        console.warn(`No phone in Meta lead ${leadgenId}, skipping`);
        continue;
      }

      // Check duplicate by meta_lead_id first, then phone
      const existing = await query(
        'SELECT id FROM leads WHERE tenant_id = $1 AND meta_lead_id = $2',
        [tenant.id, leadgenId]
      );
      if (existing.rows.length > 0) {
        console.log(`Duplicate lead skipped: ${phone}`);
        continue;
      }

      const notes = formatFieldDataNotes(leadData.field_data, {
        platform: leadData.platform, tenantName: tenant.name,
        campaignName: leadData.campaign_name, adsetName: leadData.adset_name, adName: leadData.ad_name,
      });
      let ingestion;
      try {
        ingestion = await ingestLead(tenant.id, {
          name: name || 'Unknown', phone, email, source: 'meta_ads', source_detail: leadData.ad_name || `Ad: ${adId}`,
          campaign_id: campaignId || null, meta_lead_id: leadgenId, meta_ad_id: leadData.ad_id || adId || null,
          meta_adset_id: leadData.adset_id || null, stage: 'new', notes, ...mapMetaFields(leadData.field_data),
        });
      } catch (error) { if (error.status !== 422) throw error; console.warn('Invalid Meta lead phone', leadgenId); continue; }
      if (ingestion.duplicate) continue;
      const inserted = { rows: [ingestion.lead] };
      sendWelcomeMessage({ tenantId: tenant.id, lead: inserted.rows[0] }).catch(() => {});
      applyAssignmentRules({ tenantId: tenant.id, lead: inserted.rows[0] })
        .then(() => notifyNewLead({ tenantId: tenant.id, lead: inserted.rows[0] }))
        .catch(() => {});
      checkNewLeadTriggers({ tenantId: tenant.id, lead: inserted.rows[0] }).catch(() => {});
      notifyNewLeadToAdmins(tenant.id, inserted.rows[0]).catch(() => {});

      console.log(`✅ Lead captured from Meta: ${name} (${phone}) for tenant ${tenant.id}`);
    }
  } catch (error) {
    console.error('Meta webhook error:', error);
  }
};

module.exports = { verifyWebhook, receiveLeadFormWebhook };
