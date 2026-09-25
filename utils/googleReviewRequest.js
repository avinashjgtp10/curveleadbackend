const { query } = require('../config/db');
const { sendTextMessage } = require('../services/whatsappService');
const { resolveWhatsAppCredentials } = require('./whatsappCredentials');
const { substituteVars } = require('./templateVars');

const DEFAULT_TEMPLATE = "Hi {{name}}! Thank you for choosing us — it means a lot. If you enjoyed the experience, would you mind leaving us a quick Google review? {{review_link}}";

// Fires when a lead reaches a "Won" stage: sends a WhatsApp message asking for a
// Google review, using the client's own configured review link and message.
// No-ops silently if the feature isn't turned on, no link is set, or the lead
// has no phone / opted out — same guard pattern as the welcome-message sender.
const sendReviewRequest = async ({ tenantId, leadId }) => {
  const tenantResult = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const settings = tenantResult.rows[0]?.settings || {};
  const { google_review_request_enabled, google_review_link, google_review_request_message } = settings;
  if (!google_review_request_enabled || !google_review_link) return;

  const leadResult = await query('SELECT name, phone, assigned_to, opted_out FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, tenantId]);
  const lead = leadResult.rows[0];
  if (!lead || !lead.phone || lead.opted_out) return;

  const template = (google_review_request_message || DEFAULT_TEMPLATE).replace(/\{\{review_link\}\}/gi, google_review_link);
  const message = substituteVars(template, lead);

  const credentials = await resolveWhatsAppCredentials(tenantId, lead.assigned_to);
  const result = await sendTextMessage(lead.phone, message, credentials);

  await query(
    `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status, is_automated)
     VALUES ($1, $2, 'outbound', $3, 'text', $4, $5, true)`,
    [tenantId, leadId, message, result.wa_message_id, result.success ? 'sent' : 'failed']
  ).catch(() => {});

  await query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title)
     VALUES ($1, $2, 'google_review_requested', 'Google review request sent')`,
    [tenantId, leadId]
  ).catch(() => {});
};

module.exports = { sendReviewRequest, DEFAULT_TEMPLATE };
