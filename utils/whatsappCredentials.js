const { query } = require('../config/db');

// Resolves which WhatsApp Business number to send/reply from: the lead's
// assigned rep's own connected number if they have one, else the tenant's
// shared number (tenants.settings).
const resolveWhatsAppCredentials = async (tenantId, assignedTo) => {
  if (assignedTo) {
    const userResult = await query(
      'SELECT whatsapp_phone_number_id, whatsapp_access_token FROM users WHERE id = $1 AND tenant_id = $2',
      [assignedTo, tenantId]
    );
    const u = userResult.rows[0];
    if (u?.whatsapp_phone_number_id && u?.whatsapp_access_token) {
      return { phone_number_id: u.whatsapp_phone_number_id, access_token: u.whatsapp_access_token };
    }
  }

  const tenantResult = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const { whatsapp_phone_number_id, whatsapp_access_token } = tenantResult.rows[0]?.settings || {};
  return whatsapp_phone_number_id && whatsapp_access_token
    ? { phone_number_id: whatsapp_phone_number_id, access_token: whatsapp_access_token }
    : null;
};

// Given the phone_number_id Meta says a message was received on, finds which
// user (if any) has connected that number as their own, and their tenant.
const findNumberOwner = async (phoneNumberId) => {
  if (!phoneNumberId) return null;
  const result = await query('SELECT id, tenant_id FROM users WHERE whatsapp_phone_number_id = $1', [phoneNumberId]);
  return result.rows[0] || null;
};

// Given the phone_number_id Meta says a message was received on, finds the
// tenant whose shared WhatsApp number that is (as opposed to a rep's own
// connected number — see findNumberOwner above).
const findTenantBySharedNumber = async (phoneNumberId) => {
  if (!phoneNumberId) return null;
  const result = await query(`SELECT id FROM tenants WHERE settings->>'whatsapp_phone_number_id' = $1`, [phoneNumberId]);
  return result.rows[0]?.id || null;
};

module.exports = { resolveWhatsAppCredentials, findNumberOwner, findTenantBySharedNumber };
