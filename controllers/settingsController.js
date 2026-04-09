const { query } = require('../config/db');

// GET /api/settings
const getSettings = async (req, res) => {
  try {
    const result = await query(
      `SELECT t.name, t.email, t.phone, t.address, t.city, t.state, t.academy_type, t.logo_url,
              t.grace_period_minutes, t.financial_year_start, t.lead_auto_assign, t.lead_auto_assign_type,
              t.default_assignee_id, t.auto_followup_minutes, t.meta_app_id,
              t.subscription_status, t.trial_ends_at, p.name as plan_name, p.price as plan_price
       FROM tenants t LEFT JOIN plans p ON t.plan_id = p.id WHERE t.id = $1`, [req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ settings: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/settings
const updateSettings = async (req, res) => {
  try {
    const { name, email, phone, address, city, state, academy_type, grace_period_minutes,
            lead_auto_assign, lead_auto_assign_type, default_assignee_id, auto_followup_minutes,
            meta_app_id, meta_page_access_token } = req.body;

    const result = await query(
      `UPDATE tenants SET
        name = COALESCE($1, name), email = COALESCE($2, email), phone = COALESCE($3, phone),
        address = COALESCE($4, address), city = COALESCE($5, city), state = COALESCE($6, state),
        academy_type = COALESCE($7, academy_type), grace_period_minutes = COALESCE($8, grace_period_minutes),
        lead_auto_assign = COALESCE($9, lead_auto_assign), lead_auto_assign_type = COALESCE($10, lead_auto_assign_type),
        default_assignee_id = $11, auto_followup_minutes = COALESCE($12, auto_followup_minutes),
        meta_app_id = COALESCE($13, meta_app_id), meta_page_access_token = COALESCE($14, meta_page_access_token)
       WHERE id = $15 RETURNING *`,
      [name, email, phone, address, city, state, academy_type, grace_period_minutes,
       lead_auto_assign, lead_auto_assign_type, default_assignee_id || null, auto_followup_minutes,
       meta_app_id, meta_page_access_token, req.tenantId]
    );
    res.json({ settings: result.rows[0], message: 'Settings updated.' });
  } catch (error) { console.error('Update settings error:', error); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getSettings, updateSettings };
