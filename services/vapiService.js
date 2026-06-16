const axios = require('axios');

const VAPI_API_URL = 'https://api.vapi.ai';

// ── Curated voice catalog ───────────────────────────────────────────────────
// Vapi voices are (provider, voiceId) pairs rather than a single queryable
// catalog across providers. Start with a short, known-good shortlist; this
// can later be swapped for a live lookup against Vapi's voice-library API.
const VOICE_CATALOG = [
  { id: '11labs:rachel', provider: '11labs', voiceId: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', language: 'en', gender: 'female' },
  { id: '11labs:adam', provider: '11labs', voiceId: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', language: 'en', gender: 'male' },
  { id: '11labs:bella', provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', language: 'en', gender: 'female' },
  { id: 'playht:ariana', provider: 'playht', voiceId: 'jennifer', name: 'Ariana', language: 'en', gender: 'female' },
  { id: 'azure:emma', provider: 'azure', voiceId: 'en-US-EmmaNeural', name: 'Emma', language: 'en', gender: 'female' },
];

const listVoices = () => VOICE_CATALOG;

// ── Outbound call creation ──────────────────────────────────────────────────
// POST https://api.vapi.ai/call
const createCall = async ({ apiKey, phoneNumberId, customerNumber, voiceProvider, voiceId, systemPrompt, firstMessage }) => {
  const response = await axios.post(
    `${VAPI_API_URL}/call`,
    {
      phoneNumberId,
      customer: { number: customerNumber },
      assistant: {
        model: { provider: 'groq', model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: systemPrompt }] },
        voice: { provider: voiceProvider, voiceId },
        firstMessage: firstMessage || undefined,
      },
    },
    {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );
  return { id: response.data.id, status: response.data.status };
};

const getCall = async ({ apiKey, callId }) => {
  const response = await axios.get(`${VAPI_API_URL}/call/${callId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    timeout: 10000,
  });
  return response.data;
};

// ── Webhook payload normalization ───────────────────────────────────────────
// Vapi sends "server-message" events for status updates and an
// "end-of-call-report" once the call finishes. Normalize both shapes into
// one internal representation the controller can act on regardless of
// which event triggered it.
const STATUS_MAP = {
  queued: 'queued',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  forwarding: 'in_progress',
  ended: 'completed',
};

const parseWebhookEvent = (payload) => {
  const message = payload?.message || payload;
  const call = message?.call || {};
  const providerCallId = call.id || message.callId;

  const endedReason = message.endedReason || call.endedReason;
  let status = STATUS_MAP[message.status || call.status] || 'in_progress';
  if (message.type === 'end-of-call-report' || endedReason) {
    status = /no-answer|busy/i.test(endedReason || '') ? 'no_answer'
      : /error|failed/i.test(endedReason || '') ? 'failed'
      : 'completed';
  }

  return {
    providerCallId,
    status,
    endedReason: endedReason || null,
    durationSeconds: message.durationSeconds ? Math.round(message.durationSeconds) : null,
    transcript: message.transcript || message.artifact?.transcript || null,
    recordingUrl: message.recordingUrl || message.artifact?.recordingUrl || null,
    costUsd: typeof message.cost === 'number' ? message.cost : null,
  };
};

module.exports = { listVoices, createCall, getCall, parseWebhookEvent };
