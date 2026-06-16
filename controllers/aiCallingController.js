const { query } = require('../config/db');
const vapiService = require('../services/vapiService');

// ── GET /api/ai-calling/settings ────────────────────────────────────────────
const getSettings = async (req, res) => {
  try {
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const settings = result.rows[0]?.settings || {};
    res.json({
      voice_ai_api_key: settings.voice_ai_api_key ? '••••••••' : '',
      voice_ai_phone_number_id: settings.voice_ai_phone_number_id || '',
      voice_ai_configured: !!(settings.voice_ai_api_key && settings.voice_ai_phone_number_id),
      voice_ai_webhook_url: `${process.env.FRONTEND_URL || 'https://curvelead.com'}/api/webhook/voice-ai`,
    });
  } catch (e) {
    console.error('getSettings error:', e.message);
    res.status(500).json({ error: 'Failed.' });
  }
};

// ── PUT /api/ai-calling/settings ────────────────────────────────────────────
const updateSettings = async (req, res) => {
  try {
    const { voice_ai_api_key, voice_ai_phone_number_id } = req.body;
    const result = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    const current = result.rows[0]?.settings || {};

    const updated = { ...current };
    if (voice_ai_api_key && !voice_ai_api_key.startsWith('•')) updated.voice_ai_api_key = voice_ai_api_key;
    if (voice_ai_phone_number_id !== undefined) updated.voice_ai_phone_number_id = voice_ai_phone_number_id;
    if (!updated.voice_ai_webhook_secret) {
      updated.voice_ai_webhook_secret = require('crypto').randomBytes(24).toString('hex');
    }

    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(updated), req.tenantId]);
    res.json({ message: 'AI Calling settings saved.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// ── GET /api/ai-calling/voices ──────────────────────────────────────────────
const getVoices = (req, res) => {
  res.json({ voices: vapiService.listVoices() });
};

// ── Agents CRUD ──────────────────────────────────────────────────────────────
const listAgents = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM ai_voice_agents WHERE tenant_id=$1 AND is_active=true ORDER BY is_default DESC, created_at DESC',
      [req.tenantId]
    );
    res.json({ agents: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const createAgent = async (req, res) => {
  try {
    const { name, voice_provider, voice_id, voice_name, language, system_prompt, first_message, is_default } = req.body;
    if (!name || !voice_provider || !voice_id || !system_prompt) {
      return res.status(400).json({ error: 'name, voice_provider, voice_id and system_prompt are required.' });
    }

    if (is_default) {
      await query('UPDATE ai_voice_agents SET is_default=false WHERE tenant_id=$1', [req.tenantId]);
    }

    const result = await query(
      `INSERT INTO ai_voice_agents
         (tenant_id, name, voice_provider, voice_id, voice_name, language, system_prompt, first_message, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.tenantId, name, voice_provider, voice_id, voice_name || null, language || 'en', system_prompt, first_message || null, !!is_default]
    );
    res.status(201).json({ agent: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const updateAgent = async (req, res) => {
  try {
    const { name, voice_provider, voice_id, voice_name, language, system_prompt, first_message, is_default, is_active } = req.body;

    const existing = await query('SELECT id FROM ai_voice_agents WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Agent not found.' });

    if (is_default) {
      await query('UPDATE ai_voice_agents SET is_default=false WHERE tenant_id=$1', [req.tenantId]);
    }

    const result = await query(
      `UPDATE ai_voice_agents SET
         name=COALESCE($1,name), voice_provider=COALESCE($2,voice_provider), voice_id=COALESCE($3,voice_id),
         voice_name=COALESCE($4,voice_name), language=COALESCE($5,language), system_prompt=COALESCE($6,system_prompt),
         first_message=COALESCE($7,first_message), is_default=COALESCE($8,is_default), is_active=COALESCE($9,is_active),
         updated_at=NOW()
       WHERE id=$10 AND tenant_id=$11 RETURNING *`,
      [name, voice_provider, voice_id, voice_name, language, system_prompt, first_message, is_default, is_active, req.params.id, req.tenantId]
    );
    res.json({ agent: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const deleteAgent = async (req, res) => {
  try {
    await query('DELETE FROM ai_voice_agents WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// ── POST /api/ai-calling/leads/:leadId/call ─────────────────────────────────
const callLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { agentId } = req.body;

    const leadResult = await query('SELECT id, name, phone FROM leads WHERE id=$1 AND tenant_id=$2', [leadId, req.tenantId]);
    const lead = leadResult.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });
    if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number.' });

    const tenantResult = await query('SELECT settings FROM tenants WHERE id=$1', [req.tenantId]);
    const settings = tenantResult.rows[0]?.settings || {};
    if (!settings.voice_ai_api_key || !settings.voice_ai_phone_number_id) {
      return res.status(400).json({ error: 'AI Calling is not configured. Set it up under Integrations first.' });
    }

    const agentQuery = agentId
      ? await query('SELECT * FROM ai_voice_agents WHERE id=$1 AND tenant_id=$2', [agentId, req.tenantId])
      : await query('SELECT * FROM ai_voice_agents WHERE tenant_id=$1 AND is_default=true LIMIT 1', [req.tenantId]);
    const agent = agentQuery.rows[0];
    if (!agent) return res.status(400).json({ error: 'No AI agent persona found. Create one first.' });

    // Fold in whatever the playbook has learned from past won/lost calls so
    // far, if one exists yet for this tenant — this is the feedback loop.
    const playbookResult = await query(
      'SELECT * FROM sales_playbooks WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1',
      [req.tenantId]
    );
    const playbook = playbookResult.rows[0];
    const systemPrompt = playbook ? `${agent.system_prompt}

## Learnings from past sales calls
Best practices:
${(playbook.best_practices || []).map(p => `- ${p}`).join('\n')}

Common objections and how to handle them:
${(playbook.common_objections || []).map(o => `- "${o.objection}" → ${o.recommended_response}`).join('\n')}` : agent.system_prompt;

    const call = await vapiService.createCall({
      apiKey: settings.voice_ai_api_key,
      phoneNumberId: settings.voice_ai_phone_number_id,
      customerNumber: lead.phone,
      voiceProvider: agent.voice_provider,
      voiceId: agent.voice_id,
      systemPrompt,
      firstMessage: agent.first_message,
    });

    const result = await query(
      `INSERT INTO ai_voice_calls (tenant_id, lead_id, agent_id, initiated_by, provider, provider_call_id, phone_number, status)
       VALUES ($1,$2,$3,$4,'vapi',$5,$6,'queued') RETURNING *`,
      [req.tenantId, leadId, agent.id, req.user.id, call.id, lead.phone]
    );

    res.status(201).json({ call: result.rows[0] });
  } catch (e) {
    console.error('callLead error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || 'Failed to start call.' });
  }
};

// ── GET /api/ai-calling/leads/:leadId/calls ─────────────────────────────────
const getLeadCalls = async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*, a.name as agent_name, a.voice_name
       FROM ai_voice_calls c
       LEFT JOIN ai_voice_agents a ON c.agent_id = a.id
       WHERE c.lead_id=$1 AND c.tenant_id=$2
       ORDER BY c.created_at DESC`,
      [req.params.leadId, req.tenantId]
    );
    res.json({ calls: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// ── GET /api/ai-calling/calls/:id ───────────────────────────────────────────
const getCall = async (req, res) => {
  try {
    const result = await query('SELECT * FROM ai_voice_calls WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Call not found.' });
    res.json({ call: result.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = {
  getSettings, updateSettings, getVoices,
  listAgents, createAgent, updateAgent, deleteAgent,
  callLead, getLeadCalls, getCall,
};
