// Handles a call-result message from ANY voice provider: updates the call, copies the recording
// into our own storage, and produces the summary — the same way whichever provider placed it.
const { query } = require('../config/db');

function createVoiceEventHandler(deps = {}) {
  const db = deps.query || query;
  const getProvider = deps.getProvider || require('./voice').getProvider;
  const analyze = deps.analyzeRecording || require('./groqService').analyzeRecording;
  const archive = deps.archiveRecording || require('./callRecordings').archiveRecording;
  const requireSignature = deps.requireSignature ?? (process.env.VOICE_WEBHOOK_REQUIRE_SIGNATURE === 'true');
  const warn = deps.warn || console.warn;

  return async function handleVoiceEvent({ providerId, payload, headers = {}, rawBody }) {
    const provider = getProvider(providerId);
    if (!provider) { warn(`[VoiceAI Webhook] Unknown provider "${providerId}"`); return { handled: false, reason: 'unknown_provider' }; }

    const event = provider.parseWebhookEvent(payload);
    if (!event.providerCallId) return { handled: false, reason: 'no_call_id' };

    const call = (await db(
      `SELECT c.*, t.settings FROM ai_voice_calls c JOIN tenants t ON c.tenant_id = t.id
       WHERE c.provider_call_id = $1 AND COALESCE(c.provider, 'vapi') = $2`, [event.providerCallId, provider.id])).rows[0];
    if (!call) { warn(`[VoiceAI Webhook] No ${provider.id} call found for ${event.providerCallId}`); return { handled: false, reason: 'unknown_call' }; }

    const verdict = provider.verifyWebhook({ secret: call.settings?.voice_ai_webhook_secret, rawBody: rawBody ?? JSON.stringify(payload), headers });
    if (verdict === false || (verdict === null && requireSignature)) { warn(`[VoiceAI Webhook] Rejected message for call ${call.id}`); return { handled: false, reason: 'bad_signature' }; }

    await db(
      `UPDATE ai_voice_calls SET status=$1, ended_reason=COALESCE($2,ended_reason), duration_seconds=COALESCE($3,duration_seconds),
         transcript=COALESCE($4,transcript), recording_url=COALESCE($5,recording_url), cost_usd=COALESCE($6,cost_usd), updated_at=NOW()
       WHERE id=$7`,
      [event.status, event.endedReason, event.durationSeconds, event.transcript, event.recordingUrl, event.costUsd, call.id]);

    if (event.status !== 'completed') return { handled: true, status: event.status };

    // The recording copy and the summary are independent; either failing must not lose the other.
    const [archived, analysis] = await Promise.allSettled([
      event.recordingUrl ? archive({ tenantId: call.tenant_id, callId: call.id, url: event.recordingUrl }) : Promise.resolve(null),
      event.transcript
        ? (async () => {
            const lead = (await db('SELECT name FROM leads WHERE id=$1', [call.lead_id])).rows[0];
            return analyze({ transcription: event.transcript, recordingType: 'audio', leadName: lead?.name, staffName: 'AI Agent' });
          })()
        : Promise.resolve(null),
    ]);

    if (archived.status === 'fulfilled' && archived.value) {
      // Separate statement: recording_s3_url comes from a later migration and must never block the update above.
      await db('UPDATE ai_voice_calls SET recording_s3_url=$1, recording_archived_at=NOW() WHERE id=$2', [archived.value.url, call.id])
        .catch((e) => warn(`[VoiceAI Webhook] Could not save recording copy (has migration_ai_call_recordings.sql been run?): ${e.message}`));
    } else if (archived.status === 'rejected') {
      warn(`[VoiceAI Webhook] Recording for call ${call.id} not archived (provider link kept): ${archived.reason?.message}`);
    }

    // Our analysis when it worked; otherwise at least the provider's own summary.
    let summary = analysis.status === 'fulfilled' ? analysis.value : null;
    if ((!summary || summary.error) && event.providerSummary) summary = { summary: event.providerSummary, source: 'provider' };
    if (summary) {
      await db('UPDATE ai_voice_calls SET analysis=$1 WHERE id=$2', [JSON.stringify(summary), call.id]);
      await db(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, metadata, created_by)
         VALUES ($1,$2,'ai_call','AI Voice Call Completed', $3, $4, $5)`,
        [call.tenant_id, call.lead_id,
          `Duration: ${event.durationSeconds ?? '?'}s. Sentiment: ${summary.customer_sentiment || '-'}${summary.summary ? `. ${String(summary.summary).slice(0, 300)}` : ''}`,
          JSON.stringify(summary), call.initiated_by]).catch(() => {});
    }
    await db('UPDATE leads SET last_contacted_at = NOW() WHERE id = $1', [call.lead_id]).catch(() => {});
    return { handled: true, status: 'completed', archived: archived.status === 'fulfilled' && !!archived.value, summarized: !!summary };
  };
}

module.exports = { createVoiceEventHandler };
