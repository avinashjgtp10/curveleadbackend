const axios = require('axios');

const { GRAPH_URL: META_API_URL } = require('../config/meta');

const normalizePhone = (phone) => {
  let p = phone.replace(/\D/g, '');
  if (p.length === 10) p = '91' + p;
  return p;
};

// Meta error codes that mean the token or its permissions no longer work — every send will
// fail until someone reconnects, so the workspace is flagged instead of reporting "Connected".
const AUTH_ERROR_CODES = new Set([190, 102, 10, 200, 131005]);

// Plain-language reasons for the send failures staff actually hit (the raw Meta text is logged).
const FRIENDLY_ERRORS = {
  190: 'WhatsApp login has expired. Reconnect in Integrations → WhatsApp.',
  102: 'WhatsApp login has expired. Reconnect in Integrations → WhatsApp.',
  10: 'WhatsApp access was denied. Reconnect in Integrations → WhatsApp to restore sending.',
  200: 'WhatsApp access was denied. Reconnect in Integrations → WhatsApp to restore sending.',
  131005: 'WhatsApp access was denied. Reconnect in Integrations → WhatsApp to restore sending.',
  131047: "It's been more than 24 hours since this customer's last message. Send an approved template instead.",
  131026: "This number can't receive WhatsApp messages.",
  131049: 'Meta held back this marketing message to protect engagement. Try again later or use a Utility template.',
  131056: 'Too many messages to this number in a short time. Wait a moment and try again.',
  132001: "This template doesn't exist in that language on WhatsApp.",
  132000: "The template's variables don't match what was sent.",
  130429: 'WhatsApp rate limit reached. Try again shortly.',
};

const failure = (error, phoneNumberId) => {
  const meta = error.response?.data?.error;
  const code = meta?.code;
  if (AUTH_ERROR_CODES.has(code) && phoneNumberId) flagAuthFailure(phoneNumberId).catch(() => {});
  return { success: false, code, uncertain: !error.response || error.response.status >= 500, transient: !!error.response && (error.response.status === 429 || [130429,131056].includes(code)), error: FRIENDLY_ERRORS[code] || meta?.message || error.message, raw_error: meta?.message || error.message };
};

// Mark every workspace using this number's shared connection as needing attention.
const flagAuthFailure = async (phoneNumberId) => {
  const { query } = require('../config/db');
  await query(
    `INSERT INTO integration_health (tenant_id, provider, token_valid, checked_at)
     SELECT id, 'whatsapp', false, now() FROM tenants WHERE settings->>'whatsapp_phone_number_id' = $1
     ON CONFLICT (tenant_id, provider) DO UPDATE SET token_valid = false, checked_at = now()`,
    [String(phoneNumberId)]
  );
};

// A send went through, so access works again: clear an earlier auth-failure flag.
const clearAuthFailure = (phoneNumberId) => {
  if (!phoneNumberId) return;
  const { query } = require('../config/db');
  query(
    `UPDATE integration_health SET token_valid = true, checked_at = now()
     WHERE provider = 'whatsapp' AND token_valid = false
       AND tenant_id IN (SELECT id FROM tenants WHERE settings->>'whatsapp_phone_number_id' = $1)`,
    [String(phoneNumberId)]
  ).catch(() => {});
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
      { timeout: 30000, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    clearAuthFailure(phoneNumberId);
    return { success: true, wa_message_id: response.data.messages?.[0]?.id };
  } catch (error) {
    console.error('WhatsApp send error:', error.response?.data || error.message);
    return failure(error, phoneNumberId);
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
      { timeout: 30000, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    clearAuthFailure(phoneNumberId);
    return { success: true, wa_message_id: response.data.messages?.[0]?.id };
  } catch (error) {
    console.error('WhatsApp template error:', error.response?.data || error.message);
    return failure(error, phoneNumberId);
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
// Credential-scoped, bounded last-good cache; never reuse data after a token change.
const templateCache = new Map();
const listMessageTemplates = async (wabaId, accessToken) => {
  const key = require('crypto').createHash('sha256').update(`${wabaId}:${accessToken}`).digest('hex');
  const cached = templateCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return { success: true, templates: cached.templates };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await axios.get(`${META_API_URL}/${wabaId}/message_templates`, {
        timeout: 5000,
        params: { fields: 'name,language,category,status,components,rejected_reason', limit: 100, access_token: accessToken },
      });
      const templates = response.data.data || [];
      if (templateCache.size >= 500) templateCache.delete(templateCache.keys().next().value);
      templateCache.set(key, { at: Date.now(), templates });
      return { success: true, templates };
    } catch (error) {
      const status = error.response?.status;
      const transient = !status || status === 429 || status >= 500;
      console.error('Meta template listing failed:', { status, code: error.code, attempt: attempt + 1 });
      if (transient && attempt === 0) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
      if (transient && cached && Date.now() - cached.at < 86400000) return { success: true, templates: cached.templates, stale: true };
      if (!transient) templateCache.delete(key);
      return { success: false, transient, error: error.response?.data?.error?.message || error.message, code: error.response?.data?.error?.code };
    }
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
const createMessageTemplate = async (wabaId, accessToken, { name, category, language, bodyText, examples = [], header = null, footerText = '', buttons = [] }) => {
  try {
    const components = [];
    if (header) components.push({ type: 'HEADER', format: header.type, example: { header_handle: [header.handle] } });

    const body = { type: 'BODY', text: bodyText };
    if (examples.length) body.example = { body_text: [examples] };
    components.push(body);
    if (footerText) components.push({ type: 'FOOTER', text: footerText });
    if (buttons.length) {
      components.push({
        type: 'BUTTONS',
        buttons: buttons.map(b => b.type === 'URL'
          ? { type: 'URL', text: b.text, url: b.url }
          : { type: 'QUICK_REPLY', text: b.text }),
      });
    }

    const response = await axios.post(
      `${META_API_URL}/${wabaId}/message_templates`,
      { name, category, language, components },
      { timeout: 30000, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
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

const MEDIA_TYPE_MAP = { image: 'image', pdf: 'document', doc: 'document', audio: 'audio', video: 'video', other: 'document' };

/**
 * Send a WhatsApp media message (image/document/audio/video) outside of a
 * template — used for sending an attachment inline in an open conversation.
 * Only works within the 24h session window; outside it Meta requires a
 * pre-approved template instead, same restriction as free-text messages.
 * @param {string} to
 * @param {string} fileType - the app's own file_type label ('image'|'pdf'|'doc'|'audio'|'video'|'other')
 * @param {string} mediaUrl - a publicly reachable URL (S3) Meta can fetch the file from
 * @param {string} [caption]
 * @param {object} [credentials]
 */
const sendMediaMessage = async (to, fileType, mediaUrl, caption = '', credentials = null) => {
  const { phoneNumberId, accessToken } = resolveCredentials(credentials);
  const waType = MEDIA_TYPE_MAP[fileType] || 'document';

  if (!phoneNumberId || !accessToken) {
    console.log(`📱 WhatsApp (dev) → ${to}: [${waType}] ${mediaUrl}`);
    return { success: true, dev: true, wa_message_id: `dev_${Date.now()}` };
  }

  const mediaPayload = { link: mediaUrl };
  if (caption && waType !== 'audio') mediaPayload.caption = caption;
  if (waType === 'document') mediaPayload.filename = caption || undefined;

  try {
    const response = await axios.post(
      `${META_API_URL}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to: normalizePhone(to), type: waType, [waType]: mediaPayload },
      { timeout: 30000, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    clearAuthFailure(phoneNumberId);
    return { success: true, wa_message_id: response.data.messages?.[0]?.id };
  } catch (error) {
    console.error('WhatsApp media send error:', error.response?.data || error.message);
    return failure(error, phoneNumberId);
  }
};

module.exports = {
  sendTextMessage, sendTemplate, sendMediaMessage, verifyWhatsAppNumber, listMessageTemplates,
  createMessageTemplate, uploadTemplateMedia,
};
