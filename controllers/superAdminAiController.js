const { query } = require('../config/db');

// Runs a query that may reference a table/column that has not been migrated on every
// environment yet (e.g. ai_voice_calls). A failure yields the fallback instead of a 500,
// so the rest of the AI overview still renders.
const safeRows = async (sql, params = []) => {
  try { return (await query(sql, params)).rows; }
  catch (e) { console.error('AI overview query skipped:', e.message); return []; }
};

const num = (v) => Number(v || 0);

// High / Medium / Low relative to the busiest organization, so the label means something
// without hard-coding absolute thresholds. 0 activity -> 'None'.
const usageLevel = (activity, maxActivity) => {
  if (!activity) return 'None';
  const ratio = activity / maxActivity;
  if (ratio >= 0.66) return 'High';
  if (ratio >= 0.33) return 'Medium';
  return 'Low';
};

// GET /api/super-admin/ai/overview
// Platform-wide AI picture built only from data CurveLead already stores. Credentials
// (Vapi key, Groq key) are never selected or returned — only whether they are configured.
const getAiOverview = async (req, res) => {
  try {
    const [tenants, calls, aiMessages, agents, playbooks, voiceProviders, recentCalls, recentReplies] = await Promise.all([
      safeRows(`
        SELECT id, name, subscription_status,
               COALESCE((settings->>'whatsapp_auto_responder_enabled')::boolean, false) AS auto_reply_enabled,
               (COALESCE(settings->>'voice_ai_api_key', '') <> '' AND COALESCE(settings->>'voice_ai_phone_number_id', '') <> '') AS calling_connected
        FROM tenants ORDER BY name`),
      safeRows(`
        SELECT tenant_id,
               COUNT(*) AS total_calls,
               COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS calls_today,
               COUNT(*) FILTER (WHERE status = 'completed') AS completed_calls,
               COUNT(*) FILTER (WHERE status IN ('failed', 'no_answer')) AS failed_calls,
               COALESCE(SUM(duration_seconds), 0) AS seconds,
               COUNT(*) FILTER (WHERE recording_url IS NOT NULL AND recording_url <> '') AS recordings,
               MAX(created_at) AS last_call_at
        FROM ai_voice_calls GROUP BY tenant_id`),
      safeRows(`
        SELECT tenant_id,
               COUNT(*) AS total_messages,
               COUNT(*) FILTER (WHERE status <> 'failed') AS ok_messages,
               MAX(sent_at) AS last_message_at
        FROM whatsapp_messages WHERE is_ai_generated = true GROUP BY tenant_id`),
      safeRows(`SELECT tenant_id, COUNT(*) AS agents FROM ai_voice_agents WHERE is_active = true GROUP BY tenant_id`),
      safeRows(`SELECT tenant_id, COUNT(*) AS versions, MAX(generated_at) AS last_generated_at FROM sales_playbooks GROUP BY tenant_id`),
      safeRows(`
        SELECT a.voice_provider AS provider,
               COUNT(DISTINCT a.tenant_id) AS organizations,
               COUNT(DISTINCT a.id) AS agents,
               COUNT(c.id) AS calls,
               MAX(c.created_at) AS last_call_at
        FROM ai_voice_agents a LEFT JOIN ai_voice_calls c ON c.agent_id = a.id
        WHERE a.is_active = true GROUP BY a.voice_provider ORDER BY a.voice_provider`),
      safeRows(`
        SELECT c.id, c.status, c.duration_seconds, c.created_at, t.name AS tenant_name
        FROM ai_voice_calls c LEFT JOIN tenants t ON t.id = c.tenant_id
        ORDER BY c.created_at DESC LIMIT 10`),
      safeRows(`
        SELECT m.id, m.status, m.sent_at AS created_at, t.name AS tenant_name
        FROM whatsapp_messages m LEFT JOIN tenants t ON t.id = m.tenant_id
        WHERE m.is_ai_generated = true AND m.direction = 'outbound'
        ORDER BY m.sent_at DESC LIMIT 10`),
    ]);

    const byTenant = (rows) => new Map(rows.map(r => [r.tenant_id, r]));
    const callsBy = byTenant(calls);
    const msgBy = byTenant(aiMessages);
    const agentsBy = byTenant(agents);
    const playbookBy = byTenant(playbooks);

    const totalCalls = calls.reduce((s, r) => s + num(r.total_calls), 0);
    const totalMessages = aiMessages.reduce((s, r) => s + num(r.total_messages), 0);
    const okMessages = aiMessages.reduce((s, r) => s + num(r.ok_messages), 0);

    const organizations = tenants.map(t => {
      const c = callsBy.get(t.id);
      const m = msgBy.get(t.id);
      const callCount = num(c?.total_calls);
      const messageCount = num(m?.total_messages);
      return {
        id: t.id, name: t.name, status: t.subscription_status,
        auto_reply_enabled: t.auto_reply_enabled, calling_connected: t.calling_connected,
        calls: callCount, messages: messageCount, activity: callCount + messageCount,
      };
    });
    const maxActivity = Math.max(1, ...organizations.map(o => o.activity));
    organizations.forEach(o => { o.usage = usageLevel(o.activity, maxActivity); });
    organizations.sort((a, b) => b.activity - a.activity || a.name.localeCompare(b.name));

    const callingOrgs = tenants.filter(t => t.calling_connected);
    const llmOrgIds = new Set(aiMessages.map(r => r.tenant_id));
    const lastMessageAt = aiMessages.reduce((max, r) => (!max || (r.last_message_at && r.last_message_at > max) ? r.last_message_at : max), null);
    const lastCallAt = calls.reduce((max, r) => (!max || (r.last_call_at && r.last_call_at > max) ? r.last_call_at : max), null);

    // Provider rows. The LLM key lives in the server environment and the calling key lives per
    // organization, so status is derived from configuration/usage — never from reading a key.
    const providers = [
      {
        key: 'groq', name: 'Groq', type: 'LLM / AI Reply', status: process.env.GROQ_API_KEY ? 'connected' : 'not_configured',
        organizations: llmOrgIds.size, usage: totalMessages, usage_unit: 'messages', last_sync: lastMessageAt,
      },
      {
        key: 'vapi', name: 'Vapi', type: 'AI Calling', status: callingOrgs.length ? 'connected' : 'not_configured',
        organizations: callingOrgs.length, usage: totalCalls, usage_unit: 'calls', last_sync: lastCallAt,
      },
      ...voiceProviders.map(v => ({
        key: `voice-${v.provider}`, name: v.provider, type: 'AI Calling Voice', status: 'connected',
        organizations: num(v.organizations), usage: num(v.calls), usage_unit: 'calls', last_sync: v.last_call_at,
      })),
    ];

    const activity = [
      ...recentCalls.map(c => ({
        id: `call-${c.id}`, type: 'call', title: c.status === 'completed' ? 'AI call completed' : `AI call ${String(c.status).replace(/_/g, ' ')}`,
        organization: c.tenant_name, duration_seconds: c.duration_seconds, status: c.status, at: c.created_at,
      })),
      ...recentReplies.map(m => ({
        id: `msg-${m.id}`, type: 'reply', title: 'AI reply processed',
        organization: m.tenant_name, duration_seconds: null, status: m.status === 'failed' ? 'failed' : 'success', at: m.created_at,
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 10);

    res.json({
      auto_reply: {
        enabled_orgs: tenants.filter(t => t.auto_reply_enabled).length,
        disabled_orgs: tenants.filter(t => !t.auto_reply_enabled).length,
        messages_processed: totalMessages,
        success_rate: totalMessages ? Math.round((okMessages / totalMessages) * 1000) / 10 : null,
        enabled_organizations: tenants.filter(t => t.auto_reply_enabled).map(t => ({ id: t.id, name: t.name })),
      },
      calling: {
        connected_orgs: callingOrgs.length,
        active_agents: agents.reduce((s, r) => s + num(r.agents), 0),
        calls_today: calls.reduce((s, r) => s + num(r.calls_today), 0),
        total_calls: totalCalls,
        minutes_used: Math.round(calls.reduce((s, r) => s + num(r.seconds), 0) / 60),
        recordings: calls.reduce((s, r) => s + num(r.recordings), 0),
        active_provider: callingOrgs.length ? 'Vapi' : null,
      },
      knowledge: {
        orgs_with_playbooks: playbooks.length,
        playbooks: playbooks.reduce((s, r) => s + num(r.versions), 0),
        last_updated: playbooks.reduce((max, r) => (!max || (r.last_generated_at && r.last_generated_at > max) ? r.last_generated_at : max), null),
      },
      providers,
      organizations,
      activity,
    });
  } catch (error) {
    console.error('AI overview error:', error);
    res.status(500).json({ error: 'Failed to load AI overview.' });
  }
};

module.exports = { getAiOverview };
