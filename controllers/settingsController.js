const { query } = require('../config/db');

// GET /api/settings
const getSettings = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, email, phone, business_type, logo_url, address, settings,
              subscription_status, trial_ends_at, subscription_start, subscription_end
       FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    res.json({ settings: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/settings
const updateSettings = async (req, res) => {
  try {
    const { name, email, phone, business_type, logo_url, address, settings } = req.body;
    const updates = [];
    const params = [req.tenantId];
    let i = 2;

    const fields = { name, email, phone, business_type, logo_url, address };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates.push(`${key} = $${i++}`);
        params.push(value);
      }
    }
    if (settings !== undefined) {
      updates.push(`settings = $${i++}::jsonb`);
      params.push(JSON.stringify(settings));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });
    updates.push('updated_at = NOW()');

    const result = await query(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    res.json({ settings: result.rows[0] });
  } catch (error) { console.error('Update settings error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/settings/stages - Pipeline stages
const getStages = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM lead_stages WHERE tenant_id = $1 ORDER BY pos',
      [req.tenantId]
    );
    res.json({ stages: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/settings/stages
const createStage = async (req, res) => {
  try {
    const { name, pos, color, is_won, is_lost } = req.body;
    if (!name || pos === undefined) return res.status(400).json({ error: 'Name and pos required.' });

    const result = await query(
      `INSERT INTO lead_stages (tenant_id, name, pos, color, is_won, is_lost)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.tenantId, name, pos, color || 'gray', is_won || false, is_lost || false]
    );
    res.status(201).json({ stage: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/settings/stages/:id
const updateStage = async (req, res) => {
  try {
    const { name, pos, color, is_active } = req.body;
    const result = await query(
      `UPDATE lead_stages SET name = COALESCE($1, name), pos = COALESCE($2, pos),
       color = COALESCE($3, color), is_active = COALESCE($4, is_active)
       WHERE id = $5 AND tenant_id = $6 RETURNING *`,
      [name, pos, color, is_active, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Stage not found.' });
    res.json({ stage: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/settings/stages/:id
const deleteStage = async (req, res) => {
  try {
    const result = await query('DELETE FROM lead_stages WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Stage not found.' });
    res.json({ message: 'Deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getSettings, updateSettings, getStages, createStage, updateStage, deleteStage };
