const { query } = require('../config/db');
const { sendTextMessage, sendTemplate } = require('../services/whatsappService');
const { checkTemplateConsent } = require('../services/whatsappConsent');
const { findApprovedTemplate, templateVarCount } = require('../services/bookingMessages');
const { isSessionOpen } = require('./sessionWindow');
const { resolveWhatsAppCredentials } = require('./whatsappCredentials');
const { substituteVars } = require('./templateVars');

const DEFAULT_TEMPLATE = "Hi {{name}}! Thank you for choosing us — it means a lot. If you enjoyed the experience, would you mind leaving us a quick Google review? {{review_link}}";

// Fires when a lead reaches a "Won" stage: asks for a Google review on WhatsApp.
// Free text only inside WhatsApp's 24-hour window; otherwise the approved template chosen
// in GMB settings (variables: {{1}} name, {{2}} review link), after the usual consent check.
// Never silent: when nothing can be sent, the lead's timeline says why.
const sendReviewRequest = async ({ tenantId, leadId }) => {
  const tenantResult = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const settings = tenantResult.rows[0]?.settings || {};
  const { google_review_request_enabled, google_review_link, google_review_request_message, google_review_request_template } = settings;
  if (!google_review_request_enabled || !google_review_link) return;

  const leadResult = await query('SELECT name, phone, assigned_to, opted_out FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, tenantId]);
  const lead = leadResult.rows[0];
  if (!lead || !lead.phone || lead.opted_out) return;

  const notSent = (reason) => query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
     VALUES ($1, $2, 'automation_skipped', 'Google review request not sent', $3)`,
    [tenantId, leadId, reason]
  ).catch(() => {});

  const credentials = await resolveWhatsAppCredentials(tenantId, lead.assigned_to);
  let message, result, templateName = null;
  if (await isSessionOpen(leadId)) {
    const template = (google_review_request_message || DEFAULT_TEMPLATE).replace(/\{\{review_link\}\}/gi, google_review_link);
    message = substituteVars(template, lead);
    result = await sendTextMessage(lead.phone, message, credentials);
  } else if (google_review_request_template) {
    const found = await findApprovedTemplate(settings, google_review_request_template);
    if (found.error) return notSent(found.error);
    const consent = await checkTemplateConsent({ tenantId, leadId, template: found.template });
    if (!consent.allowed) return notSent(consent.reason);
    const values = [(lead.name || 'there').trim().split(/\s+/)[0], google_review_link];
    const needed = templateVarCount(found.body);
    if (needed > values.length) return notSent(`Template "${google_review_request_template}" has ${needed} variables; a review request can fill 2 (name, review link).`);
    const parameters = values.slice(0, needed).map(text => ({ type: 'text', text }));
    templateName = google_review_request_template;
    message = found.body.replace(/\{\{(\d+)\}\}/g, (m, n) => parameters[Number(n) - 1]?.text ?? m);
    result = await sendTemplate(lead.phone, templateName, found.template.language, parameters, credentials);
  } else {
    return notSent("Outside WhatsApp's 24-hour window and no approved review-request template is selected in GMB settings.");
  }

  await query(
    `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, template_name, wa_message_id, status, is_automated)
     VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, true)`,
    [tenantId, leadId, message, templateName ? 'template' : 'text', templateName, result.wa_message_id, result.success ? 'sent' : 'failed']
  ).catch(() => {});

  if (!result.success) return notSent(result.error || 'WhatsApp rejected the message.');
  await query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title)
     VALUES ($1, $2, 'google_review_requested', 'Google review request sent')`,
    [tenantId, leadId]
  ).catch(() => {});
};

module.exports = { sendReviewRequest, DEFAULT_TEMPLATE };
