const crypto = require('crypto');
const { query } = require('../config/db');
const vapiService = require('../services/vapiService');
const { analyzeRecording } = require('../services/groqService');

// Vapi signs server-message webhooks with a shared secret configured per
// assistant/account. We store one secret per tenant (generated when AI
// Calling settings are first saved) and verify against it once we've
// resolved which tenant a call belongs to.
const verifySignature = (secret, rawBody, signatureHeader) => {
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
};

// POST /api/webhook/voice-ai
const handleVoiceAiWebhook = async (req, res) => {
  res.sendStatus(200); // Always 200 OK immediately; process async

  try {
    const event = vapiService.parseWebhookEvent(req.body);
    if (!event.providerCallId) return;

    const callResult = await query(
      `SELECT c.*, t.settings
       FROM ai_voice_calls c
       JOIN tenants t ON c.tenant_id = t.id
       WHERE c.provider_call_id = $1`,
      [event.providerCallId]
    );
    const call = callResult.rows[0];
    if (!call) return console.warn(`[VoiceAI Webhook] No call found for provider_call_id ${event.providerCallId}`);

    const webhookSecret = call.settings?.voice_ai_webhook_secret;
    const signatureHeader = req.headers['x-vapi-signature'];
    if (webhookSecret && signatureHeader && !verifySignature(webhookSecret, JSON.stringify(req.body), signatureHeader)) {
      return console.warn(`[VoiceAI Webhook] Signature mismatch for call ${call.id}`);
    }

    await query(
      `UPDATE ai_voice_calls SET
         status=$1, ended_reason=COALESCE($2,ended_reason), duration_seconds=COALESCE($3,duration_seconds),
         transcript=COALESCE($4,transcript), recording_url=COALESCE($5,recording_url),
         cost_usd=COALESCE($6,cost_usd), updated_at=NOW()
       WHERE id=$7`,
      [event.status, event.endedReason, event.durationSeconds, event.transcript, event.recordingUrl, event.costUsd, call.id]
    );

    if (event.status !== 'completed' || !event.transcript) return;

    // Reuse the existing call-analysis pipeline (same shape used for
    // human-uploaded recordings) so the frontend's AnalysisPanel works
    // unchanged for AI-agent calls too.
    const [leadRes] = await Promise.all([
      query('SELECT name FROM leads WHERE id=$1', [call.lead_id]),
    ]);

    const analysis = await analyzeRecording({
      transcription: event.transcript,
      recordingType: 'audio',
      leadName: leadRes.rows[0]?.name,
      staffName: 'AI Agent',
    });

    await query(`UPDATE ai_voice_calls SET analysis=$1 WHERE id=$2`, [JSON.stringify(analysis), call.id]);

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, metadata, created_by)
       VALUES ($1,$2,'ai_call','AI Voice Call Completed',
               'Duration: ' || COALESCE($3::text,'?') || 's. Sentiment: ' || COALESCE($4,'-'),
               $5, $6)`,
      [call.tenant_id, call.lead_id, event.durationSeconds, analysis.customer_sentiment, JSON.stringify(analysis), call.initiated_by]
    ).catch(() => {});

    await query('UPDATE leads SET last_contacted_at = NOW() WHERE id = $1', [call.lead_id]).catch(() => {});
  } catch (e) {
    console.error('[VoiceAI Webhook] error:', e.message);
  }
};

module.exports = { handleVoiceAiWebhook };
