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

module.exports = { sendTextMessage, sendTemplate };
