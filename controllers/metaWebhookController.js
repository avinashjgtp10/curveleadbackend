const { query } = require('../config/db');
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
        `SELECT id, settings->>'meta_page_access_token' AS page_access_token
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

      // Fetch lead details using the tenant's page access token
      let leadData;
      try {
        const response = await axios.get(
          `https://graph.facebook.com/v25.0/${leadgenId}`,
          { params: { access_token: tenant.page_access_token } }
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

      // Try to match campaign by ad_id
      const campaignResult = await query(
        `SELECT id FROM campaigns WHERE tenant_id = $1 AND (utm_campaign = $2 OR description LIKE $3) LIMIT 1`,
        [tenant.id, adId, `%${adId}%`]
      );
      const campaignId = campaignResult.rows[0]?.id;

      const phone = fields.phone_number || fields.phone || '';
      const name = fields.full_name || `${fields.first_name || ''} ${fields.last_name || ''}`.trim();
      const email = fields.email || '';

      if (!phone) {
        console.warn(`No phone in Meta lead ${leadgenId}, skipping`);
        continue;
      }

      // Check duplicate by meta_lead_id first, then phone
      const existing = await query(
        'SELECT id FROM leads WHERE tenant_id = $1 AND (meta_lead_id = $2 OR phone = $3)',
        [tenant.id, leadgenId, phone]
      );
      if (existing.rows.length > 0) {
        console.log(`Duplicate lead skipped: ${phone}`);
        continue;
      }

      await query(
        `INSERT INTO leads (tenant_id, name, phone, email, source, source_detail, campaign_id, meta_lead_id, stage)
         VALUES ($1, $2, $3, $4, 'meta_ads', $5, $6, $7, 'new')`,
        [tenant.id, name || 'Unknown', phone, email || null, `Ad: ${adId}`, campaignId || null, leadgenId]
      );

      console.log(`✅ Lead captured from Meta: ${name} (${phone}) for tenant ${tenant.id}`);
    }
  } catch (error) {
    console.error('Meta webhook error:', error);
  }
};

module.exports = { verifyWebhook, receiveLeadFormWebhook };
