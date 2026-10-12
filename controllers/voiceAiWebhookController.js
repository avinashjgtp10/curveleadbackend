const { createVoiceEventHandler } = require('../services/voiceCalls');

const handleEvent = createVoiceEventHandler();

// POST /api/webhook/voice-ai            (Vapi, the original address)
// POST /api/webhook/voice-ai/:provider  (any registered voice provider)
const handleVoiceAiWebhook = async (req, res) => {
  res.sendStatus(200); // Always 200 OK immediately; process async
  try {
    await handleEvent({ providerId: req.params.provider || 'vapi', payload: req.body, headers: req.headers, rawBody: req.rawBody });
  } catch (e) {
    console.error('[VoiceAI Webhook] error:', e.message);
  }
};

module.exports = { handleVoiceAiWebhook };
