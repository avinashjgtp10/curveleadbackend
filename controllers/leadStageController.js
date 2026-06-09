const { query } = require('../config/db');

// GET /api/lead-stages
const getStages = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM lead_stages WHERE tenant_id = $1 AND is_active = true ORDER BY position',
      [req.tenantId]
    );
    res.json({ stages: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch stages.' }); }
};

// POST /api/lead-stages
const createStage = async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'Stage name is required.' });

    // Get next position
    const maxPos = await query(
      'SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM lead_stages WHERE tenant_id = $1',
      [req.tenantId]
    );

    const result = await query(
      'INSERT INTO lead_stages (tenant_id, name, color, position) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.tenantId, name, color || 'gray', maxPos.rows[0].next_pos]
    );
    res.status(201).json({ stage: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed to create stage.' }); }
};

// PUT /api/lead-stages/:id
const updateStage = async (req, res) => {
  try {
    const { name, color, position } = req.body;
    const result = await query(
      'UPDATE lead_stages SET name=COALESCE($1,name), color=COALESCE($2,color), position=COALESCE($3,position) WHERE id=$4 AND tenant_id=$5 RETURNING *',
      [name ?? null, color ?? null, position ?? null, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Stage not found.' });
    res.json({ stage: result.rows[0] });
  } catch (error) {
    console.error('updateStage error:', error.message);
    res.status(500).json({ error: 'Failed to update stage.' });
  }
};

// DELETE /api/lead-stages/:id (soft delete, can't delete defaults)
const deleteStage = async (req, res) => {
  try {
    const stage = await query('SELECT is_default FROM lead_stages WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (stage.rows.length === 0) return res.status(404).json({ error: 'Stage not found.' });
    if (stage.rows[0].is_default) return res.status(400).json({ error: 'Cannot delete default stages.' });

    await query('UPDATE lead_stages SET is_active = false WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    res.json({ message: 'Stage deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed to delete stage.' }); }
};

// PUT /api/lead-stages/reorder - Reorder stages
const reorderStages = async (req, res) => {
  try {
    const { stages } = req.body; // [{ id, position }]
    for (const s of stages) {
      await query('UPDATE lead_stages SET position = $1 WHERE id = $2 AND tenant_id = $3', [s.position, s.id, req.tenantId]);
    }
    res.json({ message: 'Stages reordered.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getStages, createStage, updateStage, deleteStage, reorderStages };
