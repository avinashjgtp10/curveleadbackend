const { query } = require('../config/db');

// Surfaces a few settings-JSONB fields at the top level for frontend convenience.
const withExtras = (row) => ({
  ...row,
  bank_details: row?.settings?.bank_details || {},
  daily_report_enabled: !!row?.settings?.daily_report_enabled,
  daily_report_time: row?.settings?.daily_report_time || '08:00',
  email_reply_to: row?.settings?.email_reply_to || '',
});

// GET /api/settings
const getSettings = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, email, phone, business_type, logo_url, address, city, state,
              gst_number, pan_number, website,
              settings,
              subscription_status, trial_ends_at, subscription_start, subscription_end
       FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    res.json({ settings: withExtras(result.rows[0]) });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/settings
const updateSettings = async (req, res) => {
  try {
    const { name, email, phone, business_type, logo_url, address, city, state,
            gst_number, pan_number, website, bank_details, daily_report_enabled, daily_report_time, email_reply_to } = req.body;
    const updates = [];
    const params = [req.tenantId];
    let i = 2;

    const fields = { name, email, phone, business_type, logo_url, address, city, state, gst_number, pan_number, website };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates.push(`${key} = $${i++}`);
        params.push(value);
      }
    }

    if (daily_report_time !== undefined && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(daily_report_time)) {
      return res.status(400).json({ error: 'daily_report_time must be in HH:MM 24-hour format.' });
    }

    // Store bank_details / report / email preferences inside the settings JSONB column
    const settingsPatch = {};
    if (bank_details !== undefined) settingsPatch.bank_details = bank_details;
    if (daily_report_enabled !== undefined) settingsPatch.daily_report_enabled = daily_report_enabled;
    if (daily_report_time !== undefined) settingsPatch.daily_report_time = daily_report_time;
    if (email_reply_to !== undefined) settingsPatch.email_reply_to = email_reply_to;
    if (Object.keys(settingsPatch).length) {
      updates.push(`settings = settings || $${i++}`);
      params.push(JSON.stringify(settingsPatch));
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });
    updates.push('updated_at = NOW()');

    const result = await query(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    res.json({ settings: withExtras(result.rows[0]) });
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
    const { name, color, is_won, is_lost, meta_event_name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Stage name is required.' });

    const maxPos = await query(
      'SELECT GREATEST(COALESCE(MAX(pos), 0), COALESCE(MAX(position), 0)) + 1 as next_pos FROM lead_stages WHERE tenant_id = $1',
      [req.tenantId]
    );
    const nextPos = maxPos.rows[0].next_pos;

    const result = await query(
      `INSERT INTO lead_stages (tenant_id, name, pos, position, color, is_won, is_lost, is_active, meta_event_name)
       VALUES ($1, $2, $3, $3, $4, $5, $6, true, $7) RETURNING *`,
      [req.tenantId, name.trim(), nextPos, color || 'gray', is_won || false, is_lost || false, meta_event_name || null]
    );
    res.status(201).json({ stage: result.rows[0] });
  } catch (error) { console.error('createStage error:', error); res.status(500).json({ error: 'Failed to create stage.' }); }
};

// PUT /api/settings/stages/:id
const updateStage = async (req, res) => {
  try {
    const { name, color, is_active, is_won, is_lost, meta_event_name } = req.body;
    const result = await query(
      `UPDATE lead_stages
       SET name = COALESCE($1, name), color = COALESCE($2, color),
           is_active = COALESCE($3, is_active), is_won = COALESCE($4, is_won),
           is_lost = COALESCE($5, is_lost), meta_event_name = COALESCE($6, meta_event_name)
       WHERE id = $7 AND tenant_id = $8 RETURNING *`,
      [name ?? null, color ?? null, is_active ?? null, is_won ?? null, is_lost ?? null, meta_event_name ?? null, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Stage not found.' });
    res.json({ stage: result.rows[0] });
  } catch (error) { console.error('updateStage error:', error); res.status(500).json({ error: 'Failed.' }); }
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
