const { query } = require('../config/db');

// WhatsApp only allows free-text sends within 24h of the customer's last
// inbound message ("customer service window"). Outside that window, only
// pre-approved templates may be sent.
const isSessionOpen = async (leadId) => {
  const result = await query(
    `SELECT MAX(sent_at) AS last_inbound FROM whatsapp_messages WHERE lead_id = $1 AND direction = 'inbound'`,
    [leadId]
  );
  const lastInbound = result.rows[0]?.last_inbound;
  if (!lastInbound) return false;
  return Date.now() - new Date(lastInbound).getTime() < 24 * 60 * 60 * 1000;
};

module.exports = { isSessionOpen };
