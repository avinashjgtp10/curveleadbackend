const { query } = require('../config/db');

// GET /api/webhook/meta - Webhook verification (Meta sends this to verify)
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
};

// POST /api/webhook/meta - Receive lead from Meta Lead Form Ads
const receiveLeadFormWebhook = async (req, res) => {
  try {
    // Always respond 200 quickly to Meta
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen') {
          const leadgenId = change.value.leadgen_id;
          const pageId = change.value.page_id;
          const formId = change.value.form_id;

          // Find tenant by Meta page ID
          const tenantResult = await query(
            `SELECT id, lead_auto_assign, lead_auto_assign_type, default_assignee_id, auto_followup_minutes
             FROM tenants WHERE meta_app_id = $1 OR meta_page_access_token IS NOT NULL`,
            [pageId]
          );

          // For now, process with first matching tenant
          // In production, match by page_id stored per tenant
          if (tenantResult.rows.length === 0) {
            console.log(`⚠️ No tenant found for page ${pageId}`);
            return;
          }

          const tenant = tenantResult.rows[0];

          // Fetch lead data from Meta API
          const leadData = await fetchMetaLeadData(leadgenId, tenant);
          if (!leadData) return;

          // Map fields
          const name = getFieldValue(leadData.field_data, 'full_name') || getFieldValue(leadData.field_data, 'first_name') || 'Meta Lead';
          const phone = getFieldValue(leadData.field_data, 'phone_number') || '';
          const email = getFieldValue(leadData.field_data, 'email') || '';
          const city = getFieldValue(leadData.field_data, 'city') || '';

          // Check duplicate
          const duplicate = await query(
            'SELECT id FROM leads WHERE phone = $1 AND tenant_id = $2', [phone, tenant.id]
          );
          if (duplicate.rows.length > 0) {
            console.log(`⏭️ Duplicate lead: ${phone} for tenant ${tenant.id}`);
            return;
          }

          // Get assignee (round-robin or default)
          let assignedTo = tenant.default_assignee_id;
          if (tenant.lead_auto_assign && tenant.lead_auto_assign_type === 'round_robin') {
            const staffResult = await query(
              "SELECT id FROM users WHERE tenant_id = $1 AND role = 'staff' AND is_active = true ORDER BY last_login ASC NULLS FIRST LIMIT 1",
              [tenant.id]
            );
            if (staffResult.rows.length > 0) assignedTo = staffResult.rows[0].id;
          }

          // Create lead
          const leadResult = await query(
            `INSERT INTO leads (tenant_id, name, phone, email, location, source, source_detail, assigned_to, meta_lead_id)
             VALUES ($1, $2, $3, $4, $5, 'meta_lead_form', $6, $7, $8) RETURNING *`,
            [tenant.id, name, phone, email, city, `Form: ${formId}`, assignedTo, leadgenId]
          );

          const lead = leadResult.rows[0];

          // Auto-set follow-up
          const followupMinutes = tenant.auto_followup_minutes || 60;
          const followupAt = new Date();
          followupAt.setMinutes(followupAt.getMinutes() + followupMinutes);

          await query(
            `INSERT INTO lead_followups (tenant_id, lead_id, notes, followup_type, next_followup_at)
             VALUES ($1, $2, 'Auto-created: Meta Lead Form submission', 'call', $3)`,
            [tenant.id, lead.id, followupAt]
          );

          // Log activity
          await query(
            `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, next_action, next_action_date)
             VALUES ($1, $2, 'note', 'Lead captured from Meta Ads', $3, 'Call this lead', $4)`,
            [tenant.id, lead.id, `Auto-captured from Meta Lead Form Ad. Form ID: ${formId}`, followupAt]
          );

          // Create notification for assigned staff
          if (assignedTo) {
            await query(
              `INSERT INTO notifications (tenant_id, user_id, title, message, type, reference_type, reference_id)
               VALUES ($1, $2, 'New Meta Ad Lead!', $3, 'lead_new', 'lead', $4)`,
              [tenant.id, assignedTo, `New lead from Meta Ads: ${name} (${phone}). Call now!`, lead.id]
            );
          }

          console.log(`✅ Meta lead captured: ${name} (${phone}) for tenant ${tenant.id}`);
        }
      }
    }
  } catch (error) {
    console.error('Meta webhook error:', error);
  }
};

// POST /api/webhook/meta/whatsapp - Click-to-WhatsApp leads
const receiveWhatsAppWebhook = async (req, res) => {
  try {
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.value?.messages) {
          for (const msg of change.value.messages) {
            const phone = msg.from; // WhatsApp phone number
            const name = change.value.contacts?.[0]?.profile?.name || 'WhatsApp Lead';

            // Find tenant (simplified - in production, match by WhatsApp business number)
            const tenantResult = await query("SELECT id FROM tenants WHERE is_active = true LIMIT 1");
            if (tenantResult.rows.length === 0) return;
            const tenantId = tenantResult.rows[0].id;

            // Check duplicate
            const duplicate = await query('SELECT id FROM leads WHERE phone = $1 AND tenant_id = $2', [phone, tenantId]);
            if (duplicate.rows.length > 0) return;

            await query(
              `INSERT INTO leads (tenant_id, name, phone, source, source_detail)
               VALUES ($1, $2, $3, 'meta_whatsapp', 'Click-to-WhatsApp Ad')`,
              [tenantId, name, phone]
            );

            console.log(`✅ WhatsApp lead captured: ${name} (${phone})`);
          }
        }
      }
    }
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
  }
};

// Helper: Fetch lead data from Meta API
const fetchMetaLeadData = async (leadgenId, tenant) => {
  try {
    // In production, use tenant's page_access_token
    const token = process.env.META_PAGE_ACCESS_TOKEN;
    if (!token) {
      console.log('⚠️ No Meta page access token configured');
      return null;
    }

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${leadgenId}?access_token=${token}`
    );
    const data = await response.json();

    if (data.error) {
      console.error('Meta API error:', data.error);
      return null;
    }
    return data;
  } catch (error) {
    console.error('Fetch meta lead error:', error);
    return null;
  }
};

// Helper: Get field value from Meta lead data
const getFieldValue = (fieldData, fieldName) => {
  if (!fieldData) return '';
  const field = fieldData.find(f => f.name === fieldName);
  return field?.values?.[0] || '';
};

module.exports = { verifyWebhook, receiveLeadFormWebhook, receiveWhatsAppWebhook };
