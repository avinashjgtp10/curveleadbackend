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
  res.sendStatus(200); // Always 200 OK

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes || [];

    for (const change of changes) {
      if (change.field !== 'leadgen') continue;

      const leadgenId = change.value.leadgen_id;
      const pageId = change.value.page_id;
      const adId = change.value.ad_id;

      // Fetch lead details from Meta
      let leadData;
      try {
        const response = await axios.get(
          `https://graph.facebook.com/v18.0/${leadgenId}`,
          { params: { access_token: process.env.META_PAGE_ACCESS_TOKEN } }
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

      // Find tenant by page_id (stored in settings) - simplified: use first tenant for now
      const tenantResult = await query(
        `SELECT id FROM tenants WHERE settings->>'meta_page_id' = $1 LIMIT 1`,
        [pageId]
      );
      const tenantId = tenantResult.rows[0]?.id;
      if (!tenantId) {
        console.warn(`No tenant found for Meta page ${pageId}`);
        continue;
      }

      // Try to match campaign by ad_id
      const campaignResult = await query(
        `SELECT id FROM campaigns WHERE tenant_id = $1 AND (utm_campaign = $2 OR description LIKE $3) LIMIT 1`,
        [tenantId, adId, `%${adId}%`]
      );
      const campaignId = campaignResult.rows[0]?.id;

      // Create lead
      const phone = fields.phone_number || fields.phone || '';
      const name = fields.full_name || `${fields.first_name || ''} ${fields.last_name || ''}`.trim();
      const email = fields.email || '';

      if (!phone) {
        console.warn('No phone in Meta lead, skipping');
        continue;
      }

      // Check duplicate
      const existing = await query('SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, phone]);
      if (existing.rows.length > 0) {
        console.log(`Duplicate lead skipped: ${phone}`);
        continue;
      }

      await query(
        `INSERT INTO leads (tenant_id, name, phone, email, source, source_detail, campaign_id, meta_lead_id, stage)
         VALUES ($1, $2, $3, $4, 'meta_ads', $5, $6, $7, 'new')`,
        [tenantId, name || 'Unknown', phone, email, `Ad: ${adId}`, campaignId, leadgenId]
      );

      console.log(`✅ Lead captured from Meta: ${name} (${phone})`);
    }
  } catch (error) {
    console.error('Meta webhook error:', error);
  }
};

module.exports = { verifyWebhook, receiveLeadFormWebhook };
