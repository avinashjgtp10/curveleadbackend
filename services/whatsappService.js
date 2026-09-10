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
 * @param {Array}  [parameters] - BODY parameters
 * @param {object} [credentials]
 * @param {{ type: 'image'|'video'|'document', link: string }} [headerMedia] - optional media header
 */
const sendTemplate = async (to, templateName, languageCode = 'en', parameters = [], credentials = null, headerMedia = null) => {
  const { phoneNumberId, accessToken } = resolveCredentials(credentials);

  if (!phoneNumberId || !accessToken) {
    console.log(`📱 WhatsApp Template (dev) → ${to}: ${templateName}`);
    return { success: true, dev: true };
  }

  const components = [];
  if (headerMedia) {
    components.push({ type: 'header', parameters: [{ type: headerMedia.type, [headerMedia.type]: { link: headerMedia.link } }] });
  }
  if (parameters.length) components.push({ type: 'body', parameters });

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
          components: components.length ? components : undefined,
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

/**
 * Submit a new message template to Meta for approval.
 * Supports a BODY (with optional {{n}} variables) plus an optional media
 * header — buttons/footer aren't supported, matching what the broadcast
 * sender is able to fill in.
 * @param {string} wabaId
 * @param {string} accessToken
 * @param {{ name: string, category: string, language: string, bodyText: string, examples: string[], header?: { type: 'IMAGE'|'VIDEO'|'DOCUMENT', handle: string } }} tmpl
 */
const createMessageTemplate = async (wabaId, accessToken, { name, category, language, bodyText, examples = [], header = null }) => {
  try {
    const components = [];
    if (header) components.push({ type: 'HEADER', format: header.type, example: { header_handle: [header.handle] } });

    const body = { type: 'BODY', text: bodyText };
    if (examples.length) body.example = { body_text: [examples] };
    components.push(body);

    const response = await axios.post(
      `${META_API_URL}/${wabaId}/message_templates`,
      { name, category, language, components },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return { success: true, id: response.data.id, status: response.data.status || 'PENDING' };
  } catch (error) {
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
};

/**
 * Upload a file for use as a template's media header example, via Meta's
 * resumable upload API. Returns a `handle` — a write-once reference used in
 * the template's HEADER.example.header_handle at creation time.
 * @param {string} appId - Meta App ID (not the WABA ID)
 * @param {string} accessToken
 * @param {Buffer} buffer
 * @param {string} mimeType
 */
const uploadTemplateMedia = async (appId, accessToken, buffer, mimeType) => {
  try {
    const start = await axios.post(`${META_API_URL}/${appId}/uploads`, null, {
      params: { file_length: buffer.length, file_type: mimeType, access_token: accessToken },
    });
    const upload = await axios.post(`${META_API_URL}/${start.data.id}`, buffer, {
      headers: { Authorization: `OAuth ${accessToken}`, file_offset: '0', 'Content-Type': 'application/octet-stream' },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return { success: true, handle: upload.data.h };
  } catch (error) {
    return { success: false, error: error.response?.data?.error?.message || error.message };
  }
};

module.exports = {
  sendTextMessage, sendTemplate, verifyWhatsAppNumber, listMessageTemplates,
  createMessageTemplate, uploadTemplateMedia,
};
