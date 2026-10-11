const crypto = require('crypto');
const vapi = require('../vapiService');

// Vapi adapter. Every voice provider implements this same small contract, so the rest of
// CurveLead (calling, webhooks, recordings, summaries) never knows which one is behind it:
//
//   id, label
//   credentials        fields the workspace must supply (shown in Integrations)
//   listVoices()       [{ id, provider, voiceId, name, language, gender }]
//   createCall({ credentials: { apiKey, phoneNumberId }, customerNumber, voice: { provider, voiceId },
//                systemPrompt, firstMessage })  →  { id, status }
//   parseWebhookEvent(payload)  →  { providerCallId, status, endedReason, durationSeconds,
//                                    transcript, recordingUrl, costUsd, providerSummary }
//   verifyWebhook({ secret, rawBody, headers })  →  true | false

const verifyWebhook = ({ secret, rawBody, headers }) => {
  const signature = headers?.['x-vapi-signature'];
  if (!secret || !signature) return null; // nothing to check against (legacy: Vapi's signing is optional)
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature))); } catch { return false; }
};

module.exports = {
  id: 'vapi',
  label: 'Vapi',
  credentials: [
    { key: 'api_key', label: 'Vapi API key', secret: true },
    { key: 'phone_number_id', label: 'Vapi phone number ID' },
  ],
  listVoices: vapi.listVoices,
  createCall: ({ credentials, customerNumber, voice, systemPrompt, firstMessage }) => vapi.createCall({
    apiKey: credentials.apiKey, phoneNumberId: credentials.phoneNumberId, customerNumber,
    voiceProvider: voice.provider, voiceId: voice.voiceId, systemPrompt, firstMessage,
  }),
  parseWebhookEvent: vapi.parseWebhookEvent,
  verifyWebhook,
};
