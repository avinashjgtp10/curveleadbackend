const { query } = require('../config/db');

// GET /api/lead-statuses?stage_id=uuid
const getStatuses = async (req, res) => {
  try {
    const { stage_id } = req.query;
    const params = [req.tenantId];
    let filter = '';

    if (stage_id) {
      filter = ' AND ls.stage_id = $2';
      params.push(stage_id);
    }

    const result = await query(
      `SELECT ls.*, lg.name as stage_name
       FROM lead_statuses ls
       LEFT JOIN lead_stages lg ON ls.stage_id = lg.id
       WHERE ls.tenant_id = $1 AND ls.is_active = true${filter}
       ORDER BY lg.pos NULLS LAST, ls.pos ASC`,
      params
    );
    res.json({ statuses: result.rows });
  } catch (error) {
    console.error('getStatuses error:', error.message);
    res.status(500).json({ error: 'Failed to fetch statuses.' });
  }
};

// GET /api/lead-statuses/by-stage  — all stages with their statuses
const getStatusesByStage = async (req, res) => {
  try {
    const stages = await query(
      `SELECT id, name, color, pos, is_won, is_lost FROM lead_stages
       WHERE tenant_id = $1 AND is_active = true ORDER BY pos ASC`,
      [req.tenantId]
    );

    const statuses = await query(
      `SELECT id, stage_id, name, color, pos, is_default FROM lead_statuses
       WHERE tenant_id = $1 AND is_active = true ORDER BY pos ASC`,
      [req.tenantId]
    );

    const statusMap = {};
    for (const s of statuses.rows) {
      const key = s.stage_id || '__unlinked__';
      if (!statusMap[key]) statusMap[key] = [];
      statusMap[key].push(s);
    }

    const result = stages.rows.map(stage => ({
      ...stage,
      statuses: statusMap[stage.id] || [],
    }));

    // Append unlinked statuses
    if (statusMap['__unlinked__']) {
      result.push({ id: null, name: 'General', statuses: statusMap['__unlinked__'] });
    }

    res.json({ stages: result });
  } catch (error) {
    console.error('getStatusesByStage error:', error.message);
    res.status(500).json({ error: 'Failed to fetch stages with statuses.' });
  }
};

// POST /api/lead-statuses
const createStatus = async (req, res) => {
  try {
    const { name, stage_id, color, is_default } = req.body;
    if (!name) return res.status(400).json({ error: 'Status name is required.' });

    // Verify stage belongs to tenant if provided
    if (stage_id) {
      const stageCheck = await query(
        'SELECT id FROM lead_stages WHERE id = $1 AND tenant_id = $2',
        [stage_id, req.tenantId]
      );
      if (!stageCheck.rows.length) return res.status(404).json({ error: 'Stage not found.' });
    }

    const maxPos = await query(
      'SELECT COALESCE(MAX(pos), 0) + 1 as next_pos FROM lead_statuses WHERE tenant_id = $1 AND stage_id IS NOT DISTINCT FROM $2',
      [req.tenantId, stage_id || null]
    );

    const result = await query(
      `INSERT INTO lead_statuses (tenant_id, stage_id, name, color, pos, is_default, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
      [req.tenantId, stage_id || null, name, color || '#6B7280', maxPos.rows[0].next_pos, is_default || false]
    );
    res.status(201).json({ status: result.rows[0] });
  } catch (error) {
    console.error('createStatus error:', error.message);
    res.status(500).json({ error: 'Failed to create status.' });
  }
};

// PUT /api/lead-statuses/:id
const updateStatus = async (req, res) => {
  try {
    const { name, color, stage_id, is_default, is_active } = req.body;

    const result = await query(
      `UPDATE lead_statuses
       SET name       = COALESCE($1, name),
           color      = COALESCE($2, color),
           stage_id   = CASE WHEN $3::text = '__clear__' THEN NULL ELSE COALESCE($3::uuid, stage_id) END,
           is_default = COALESCE($4, is_default),
           is_active  = COALESCE($5, is_active),
           updated_at = NOW()
       WHERE id = $6 AND tenant_id = $7
       RETURNING *`,
      [name ?? null, color ?? null, stage_id ?? null, is_default ?? null, is_active ?? null, req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Status not found.' });
    res.json({ status: result.rows[0] });
  } catch (error) {
    console.error('updateStatus error:', error.message);
    res.status(500).json({ error: 'Failed to update status.' });
  }
};

// DELETE /api/lead-statuses/:id
const deleteStatus = async (req, res) => {
  try {
    const check = await query(
      'SELECT is_default FROM lead_statuses WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Status not found.' });
    if (check.rows[0].is_default) return res.status(400).json({ error: 'Cannot delete default statuses.' });

    await query(
      'UPDATE lead_statuses SET is_active = false, updated_at = NOW() WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    res.json({ message: 'Status deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete status.' });
  }
};

// PUT /api/lead-statuses/reorder
const reorderStatuses = async (req, res) => {
  try {
    const { statuses } = req.body; // [{ id, pos }]
    if (!Array.isArray(statuses)) return res.status(400).json({ error: 'statuses array required.' });

    for (const s of statuses) {
      await query(
        'UPDATE lead_statuses SET pos = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
        [s.pos, s.id, req.tenantId]
      );
    }
    res.json({ message: 'Statuses reordered.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reorder statuses.' });
  }
};

// GET /api/lead-statuses/history/:leadId
const getLeadHistory = async (req, res) => {
  try {
    const result = await query(
      `SELECT h.*, u.name as changed_by_name
       FROM lead_stage_history h
       LEFT JOIN users u ON h.changed_by = u.id
       WHERE h.lead_id = $1 AND h.tenant_id = $2
       ORDER BY h.changed_at DESC`,
      [req.params.leadId, req.tenantId]
    );
    res.json({ history: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
};

module.exports = { getStatuses, getStatusesByStage, createStatus, updateStatus, deleteStatus, reorderStatuses, getLeadHistory };
