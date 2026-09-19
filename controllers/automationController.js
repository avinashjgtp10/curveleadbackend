const { query, transaction } = require('../config/db');

// ── Sequences ────────────────────────────────────────────────────────────

const getSequences = async (req, res) => {
  try {
    const result = await query(
      `SELECT s.*,
              COALESCE(json_agg(
                json_build_object(
                  'id', st.id, 'step_order', st.step_order, 'delay_minutes', st.delay_minutes,
                  'channel', st.channel, 'message', st.message, 'email_subject', st.email_subject,
                  'approved_template_name', st.approved_template_name,
                  'ai_generated', st.ai_generated, 'ai_instructions', st.ai_instructions
                ) ORDER BY st.step_order
              ) FILTER (WHERE st.id IS NOT NULL), '[]') AS steps
       FROM automation_sequences s
       LEFT JOIN automation_sequence_steps st ON st.sequence_id = s.id
       WHERE s.tenant_id = $1
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
      [req.tenantId]
    );
    res.json({ sequences: result.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const saveSteps = async (client, tenantId, sequenceId, steps) => {
  await client.query('DELETE FROM automation_sequence_steps WHERE sequence_id = $1', [sequenceId]);
  for (let i = 0; i < (steps || []).length; i++) {
    const s = steps[i];
    if (!s.ai_generated && !s.message?.trim()) continue;
    await client.query(
      `INSERT INTO automation_sequence_steps (tenant_id, sequence_id, step_order, delay_minutes, channel, message, email_subject, approved_template_name, ai_generated, ai_instructions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        tenantId, sequenceId, i, s.delay_minutes || 0, s.channel || 'whatsapp', (s.message || '').trim(),
        s.email_subject || null, s.approved_template_name || null,
        s.ai_generated === true, s.ai_instructions?.trim() || null,
      ]
    );
  }
};

const createSequence = async (req, res) => {
  try {
    const { name, description, steps } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' });

    const sequenceId = await transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO automation_sequences (tenant_id, name, description) VALUES ($1,$2,$3) RETURNING id`,
        [req.tenantId, name.trim(), description || null]
      );
      const id = result.rows[0].id;
      await saveSteps(client, req.tenantId, id, steps);
      return id;
    });

    res.status(201).json({ id: sequenceId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const updateSequence = async (req, res) => {
  try {
    const { name, description, is_active, steps } = req.body;

    const owned = await query('SELECT id FROM automation_sequences WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Sequence not found.' });

    await transaction(async (client) => {
      await client.query(
        `UPDATE automation_sequences
         SET name = COALESCE($1, name), description = COALESCE($2, description),
             is_active = COALESCE($3, is_active), updated_at = NOW()
         WHERE id = $4`,
        [name ?? null, description ?? null, is_active ?? null, req.params.id]
      );
      if (steps !== undefined) await saveSteps(client, req.tenantId, req.params.id, steps);
    });

    res.json({ message: 'Saved.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const deleteSequence = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM automation_sequences WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sequence not found.' });
    res.json({ message: 'Deleted.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// ── Rules ────────────────────────────────────────────────────────────────

const getRules = async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, s.name AS sequence_name
       FROM automation_rules r
       JOIN automation_sequences s ON s.id = r.sequence_id
       WHERE r.tenant_id = $1
       ORDER BY r.created_at DESC`,
      [req.tenantId]
    );
    res.json({ rules: result.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const TRIGGER_TYPES = ['new_lead', 'stage_change', 'campaign', 'lead_source', 'lead_status'];

const createRule = async (req, res) => {
  try {
    const { name, trigger_type, stage_name, campaign_id, source_value, status_value, sequence_id } = req.body;
    if (!name?.trim() || !trigger_type || !sequence_id) {
      return res.status(400).json({ error: 'Name, trigger type and sequence are required.' });
    }
    if (!TRIGGER_TYPES.includes(trigger_type)) {
      return res.status(400).json({ error: 'Invalid trigger type.' });
    }
    if (trigger_type === 'stage_change' && !stage_name?.trim()) {
      return res.status(400).json({ error: 'Stage is required for a stage-change trigger.' });
    }
    if (trigger_type === 'campaign' && !campaign_id) {
      return res.status(400).json({ error: 'Campaign is required for a campaign trigger.' });
    }
    if (trigger_type === 'lead_source' && !source_value?.trim()) {
      return res.status(400).json({ error: 'Source is required for a lead-source trigger.' });
    }
    if (trigger_type === 'lead_status' && !status_value?.trim()) {
      return res.status(400).json({ error: 'Status is required for a lead-status trigger.' });
    }

    const result = await query(
      `INSERT INTO automation_rules (tenant_id, name, trigger_type, stage_name, campaign_id, source_value, status_value, sequence_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        req.tenantId, name.trim(), trigger_type,
        trigger_type === 'stage_change' ? stage_name.trim() : null,
        trigger_type === 'campaign' ? campaign_id : null,
        trigger_type === 'lead_source' ? source_value.trim() : null,
        trigger_type === 'lead_status' ? status_value.trim() : null,
        sequence_id,
      ]
    );
    res.status(201).json({ rule: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const updateRule = async (req, res) => {
  try {
    const { name, trigger_type, stage_name, campaign_id, source_value, status_value, sequence_id, is_active } = req.body;
    if (trigger_type && !TRIGGER_TYPES.includes(trigger_type)) {
      return res.status(400).json({ error: 'Invalid trigger type.' });
    }

    const result = await query(
      `UPDATE automation_rules
       SET name = COALESCE($1, name), trigger_type = COALESCE($2, trigger_type),
           stage_name = CASE WHEN $2 IS NOT NULL AND $2 != 'stage_change' THEN NULL ELSE COALESCE($3, stage_name) END,
           campaign_id = CASE WHEN $2 IS NOT NULL AND $2 != 'campaign' THEN NULL ELSE COALESCE($4, campaign_id) END,
           source_value = CASE WHEN $2 IS NOT NULL AND $2 != 'lead_source' THEN NULL ELSE COALESCE($5, source_value) END,
           status_value = CASE WHEN $2 IS NOT NULL AND $2 != 'lead_status' THEN NULL ELSE COALESCE($6, status_value) END,
           sequence_id = COALESCE($7, sequence_id), is_active = COALESCE($8, is_active)
       WHERE id = $9 AND tenant_id = $10 RETURNING *`,
      [
        name ?? null, trigger_type ?? null, stage_name ?? null, campaign_id ?? null,
        source_value ?? null, status_value ?? null,
        sequence_id ?? null, is_active ?? null, req.params.id, req.tenantId,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ rule: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const deleteRule = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM automation_rules WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ message: 'Deleted.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = {
  getSequences, createSequence, updateSequence, deleteSequence,
  getRules, createRule, updateRule, deleteRule,
};
