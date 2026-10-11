const { query } = require('../config/db');
const { sendTextMessage, sendTemplate } = require('../services/whatsappService');
const { checkTemplateConsent } = require('../services/whatsappConsent');
const { findApprovedTemplate, templateVarCount } = require('../services/bookingMessages');
const { isSessionOpen } = require('./sessionWindow');
const { substituteVars } = require('./templateVars');

// Sends the workspace's welcome message to a newly created lead.
//
// A new lead hasn't messaged you, so WhatsApp's 24-hour window is closed and plain text is
// rejected: the welcome goes out as the approved template chosen in WhatsApp → Automation →
// Auto messages (consent is checked like any other template send). Plain text is used only
// when the lead has messaged in the last 24 hours. Whatever happens, the lead's timeline says
// so — a welcome that didn't go out is never silent.
function createWelcomeSender(deps = {}) {
  const db = deps.query || query;
  const textSend = deps.sendTextMessage || sendTextMessage;
  const templateSend = deps.sendTemplate || sendTemplate;
  const consentCheck = deps.checkTemplateConsent || checkTemplateConsent;
  const findTemplate = deps.findApprovedTemplate || findApprovedTemplate;
  const sessionOpen = deps.isSessionOpen || isSessionOpen;

  return async function sendWelcomeMessage({ tenantId, lead }) {
    const settings = (await db('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]?.settings || {};
    const {
      whatsapp_auto_responder_enabled: enabled, whatsapp_auto_responder_message: text,
      whatsapp_auto_responder_template: templateName,
      whatsapp_phone_number_id: phoneNumberId, whatsapp_access_token: accessToken,
    } = settings;
    if (!enabled || (!text && !templateName)) return { sent: false, reason: 'off' };

    const note = (title, description) => db(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description) VALUES ($1, $2, 'automation_skipped', $3, $4)`,
      [tenantId, lead.id, title, description]).catch(() => {});
    const skip = async (reason) => { await note('Welcome message not sent', reason); return { sent: false, reason }; };

    if (!lead.phone) return skip('The lead has no phone number.');
    if (!phoneNumberId || !accessToken) return skip('WhatsApp is not connected.');
    const credentials = { phone_number_id: phoneNumberId, access_token: accessToken };

    let message, result, sentTemplate = null;
    if (await sessionOpen(lead.id)) {
      if (!text) return skip('The lead already messaged you; no free-text welcome is set.');
      message = substituteVars(text, lead);
      result = await textSend(lead.phone, message, credentials);
    } else if (templateName) {
      const found = await findTemplate(settings, templateName);
      if (found.error) return skip(found.error);
      const consent = await consentCheck({ tenantId, leadId: lead.id, template: found.template });
      if (!consent.allowed) return skip(`${consent.reason} Use a Utility welcome template, or record the lead's opt-in.`);
      const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
      const parameters = Array.from({ length: templateVarCount(found.body) }, () => ({ type: 'text', text: first }));
      message = found.body.replace(/\{\{(\d+)\}\}/g, (m, n) => parameters[Number(n) - 1]?.text ?? m);
      sentTemplate = templateName;
      result = await templateSend(lead.phone, templateName, found.template.language, parameters, credentials);
    } else {
      return skip("WhatsApp only allows an approved template to a lead who hasn't messaged you yet, and none is chosen. Pick one in WhatsApp → Automation → Auto messages.");
    }

    const saved = await db(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, template_name, wa_message_id, status, is_automated)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, true) RETURNING id`,
      [tenantId, lead.id, message, sentTemplate ? 'template' : 'text', sentTemplate, result.wa_message_id, result.success ? 'sent' : 'failed']).catch(() => null);
    if (!result.success) {
      if (saved?.rows[0]) db('UPDATE whatsapp_messages SET error_detail = $2 WHERE id = $1', [saved.rows[0].id, String(result.error || '').slice(0, 500)]).catch(() => {});
      return skip(result.error || 'WhatsApp rejected the message.');
    }
    return { sent: true, via: sentTemplate ? 'template' : 'text' };
  };
}

const sendWelcomeMessage = createWelcomeSender();
module.exports = { sendWelcomeMessage, createWelcomeSender };
