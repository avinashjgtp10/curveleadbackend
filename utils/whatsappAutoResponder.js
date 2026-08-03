const { query } = require('../config/db');
const { sendTextMessage } = require('../services/whatsappService');
const { substituteVars } = require('./templateVars');

// Sends the tenant's configured welcome message to a newly-created lead.
// No-ops silently if the auto-responder isn't enabled/configured for the tenant.
const sendWelcomeMessage = async ({ tenantId, lead }) => {
  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const settings = result.rows[0]?.settings || {};
  const {
    whatsapp_auto_responder_enabled, whatsapp_auto_responder_message,
    whatsapp_phone_number_id, whatsapp_access_token,
  } = settings;

  if (!whatsapp_auto_responder_enabled || !whatsapp_auto_responder_message) return;
  if (!whatsapp_phone_number_id || !whatsapp_access_token || !lead.phone) return;

  const message = substituteVars(whatsapp_auto_responder_message, lead);
  const sendResult = await sendTextMessage(lead.phone, message, {
    phone_number_id: whatsapp_phone_number_id,
    access_token: whatsapp_access_token,
  });

  await query(
    `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status)
     VALUES ($1, $2, 'outbound', $3, 'text', $4, $5)`,
    [tenantId, lead.id, message, sendResult.wa_message_id, sendResult.success ? 'sent' : 'failed']
  ).catch(() => {});
};

module.exports = { sendWelcomeMessage };
