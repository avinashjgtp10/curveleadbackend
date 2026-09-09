const axios = require('axios');

const META_API_URL = 'https://graph.facebook.com/v25.0';

const normalizePhone = (phone) => {
  let p = phone.replace(/\D/g, '');
  if (p.length === 10) p = '91' + p;
  return p;
};

// Resolve credentials: tenant-level first, then global env fallback
const resolveCredentials = (creds) => ({
  phoneNumberId: creds?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken:   creds?.access_token   || process.env.WHATSAPP_ACCESS_TOKEN,
});

/**
 * Send WhatsApp text message
 * @param {string} to - recipient phone number
 * @param {string} message - message body
 * @param {object} [credentials] - { phone_number_id, access_token } for per-tenant sending
 */
const sendTextMessage = async (to, message, credentials = null) => {
  const { phoneNumberId, accessToken } = resolveCredentials(credentials);

  if (!phoneNumberId || !accessToken) {
    console.log(`📱 WhatsApp (dev) → ${to}: ${message}`);
    return { success: true, dev: true, wa_message_id: `dev_${Date.now()}` };
  }

  try {
    const response = await axios.post(
      `${META_API_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: normalizePhone(to),
        type: 'text',
        text: { body: message },
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return { success: true, wa_message_id: response.data.messages?.[0]?.id };
  } catch (error) {
    console.error('WhatsApp send error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
};

/**
 * Send WhatsApp template message
 * @param {string} to
 * @param {string} templateName - pre-approved template name in Meta Business Manager
 * @param {string} [languageCode]
 * @param {Array}  [parameters]
 * @param {object} [credentials]
 */
const sendTemplate = async (to, templateName, languageCode = 'en', parameters = [], credentials = null) => {
  const { phoneNumberId, accessToken } = resolveCredentials(credentials);

  if (!phoneNumberId || !accessToken) {
    console.log(`📱 WhatsApp Template (dev) → ${to}: ${templateName}`);
    return { success: true, dev: true };
  }

  try {
    const response = await axios.post(
      `${META_API_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: normalizePhone(to),
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: parameters.length ? [{ type: 'body', parameters }] : undefined,
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return { success: true, wa_message_id: response.data.messages?.[0]?.id };
  } catch (error) {
    console.error('WhatsApp template error:', error.response?.data || error.message);
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
};

/**
 * Verify a Phone Number ID + Access Token pair actually works, by asking
 * Meta for that number's details.
 */
const verifyWhatsAppNumber = async (phoneNumberId, accessToken) => {
  try {
    const response = await axios.get(`${META_API_URL}/${phoneNumberId}`, {
      params: { fields: 'verified_name,display_phone_number', access_token: accessToken },
    });
    return {
      verified: true,
      display_phone_number: response.data.display_phone_number || '',
      verified_name: response.data.verified_name || '',
    };
  } catch (error) {
    return { verified: false, error: error.response?.data?.error?.message || error.message };
  }
};

/**
 * List the tenant's Meta-approved message templates (for bulk broadcast).
 * @param {string} wabaId - WhatsApp Business Account ID
 * @param {string} accessToken
 */
const listMessageTemplates = async (wabaId, accessToken) => {
  try {
    const response = await axios.get(`${META_API_URL}/${wabaId}/message_templates`, {
      params: { fields: 'name,language,category,status,components', limit: 100, access_token: accessToken },
    });
    return { success: true, templates: response.data.data || [] };
  } catch (error) {
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
};

module.exports = { sendTextMessage, sendTemplate, verifyWhatsAppNumber, listMessageTemplates };
