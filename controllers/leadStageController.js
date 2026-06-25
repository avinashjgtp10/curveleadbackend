const { query } = require('../config/db');

// GET /api/lead-stages
const getStages = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, color, pos, is_won, is_lost, is_active
       FROM lead_stages WHERE tenant_id = $1 AND is_active = true ORDER BY pos ASC`,
      [req.tenantId]
    );
    res.json({ stages: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stages.' });
  }
};

// POST /api/lead-stages
const createStage = async (req, res) => {
  try {
    const { name, color, is_won, is_lost } = req.body;
    if (!name) return res.status(400).json({ error: 'Stage name is required.' });

    const maxPos = await query(
      'SELECT COALESCE(MAX(pos), 0) + 1 as next_pos FROM lead_stages WHERE tenant_id = $1',
      [req.tenantId]
    );
    const pos = maxPos.rows[0].next_pos;

    const result = await query(
      `INSERT INTO lead_stages (tenant_id, name, color, pos, position, is_won, is_lost, is_active)
       VALUES ($1, $2, $3, $4, $4, $5, $6, true) RETURNING id, name, color, pos, is_won, is_lost, is_active`,
      [req.tenantId, name, color || 'blue', pos, is_won || false, is_lost || false]
    );
    res.status(201).json({ stage: result.rows[0] });
  } catch (error) {
    console.error('createStage error:', error.message);
    res.status(500).json({ error: 'Failed to create stage.' });
  }
};

// PUT /api/lead-stages/:id
const updateStage = async (req, res) => {
  try {
    const { name, color, is_won, is_lost, is_active } = req.body;

    const result = await query(
      `UPDATE lead_stages
       SET name      = COALESCE($1, name),
           color     = COALESCE($2, color),
           is_won    = COALESCE($3, is_won),
           is_lost   = COALESCE($4, is_lost),
           is_active = COALESCE($5, is_active)
       WHERE id = $6 AND tenant_id = $7
       RETURNING id, name, color, pos, is_won, is_lost, is_active`,
      [name ?? null, color ?? null, is_won ?? null, is_lost ?? null, is_active ?? null, req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Stage not found.' });
    res.json({ stage: result.rows[0] });
  } catch (error) {
    console.error('updateStage error:', error.message);
    res.status(500).json({ error: 'Failed to update stage.' });
  }
};

// DELETE /api/lead-stages/:id (soft delete)
const deleteStage = async (req, res) => {
  try {
    const stage = await query(
      'SELECT is_default FROM lead_stages WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!stage.rows.length) return res.status(404).json({ error: 'Stage not found.' });
    if (stage.rows[0].is_default) return res.status(400).json({ error: 'Cannot delete default stages.' });

    await query(
      'UPDATE lead_stages SET is_active = false WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    res.json({ message: 'Stage deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete stage.' });
  }
};

// PUT /api/lead-stages/reorder
const reorderStages = async (req, res) => {
  try {
    const { stages } = req.body; // [{ id, pos }]
    if (!Array.isArray(stages)) return res.status(400).json({ error: 'stages array required.' });

    for (const s of stages) {
      await query(
        'UPDATE lead_stages SET pos = $1, position = $1 WHERE id = $2 AND tenant_id = $3',
        [s.pos, s.id, req.tenantId]
      );
    }
    res.json({ message: 'Stages reordered.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reorder stages.' });
  }
};

module.exports = { getStages, createStage, updateStage, deleteStage, reorderStages };
