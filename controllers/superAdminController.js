const { query } = require('../config/db');

// GET /api/super-admin/stats - Platform stats
const getPlatformStats = async (req, res) => {
  try {
    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM tenants) as total_tenants,
        (SELECT COUNT(*) FROM tenants WHERE subscription_status = 'trial') as trial_tenants,
        (SELECT COUNT(*) FROM tenants WHERE subscription_status = 'active') as active_tenants,
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM leads) as total_leads,
        (SELECT COUNT(*) FROM whatsapp_messages) as total_messages,
        (SELECT COALESCE(SUM(actual_spend), 0) FROM campaigns) as total_campaign_spend
    `);

    const mrr = await query(`
      SELECT COALESCE(SUM(p.price), 0) as mrr FROM tenants t
      JOIN plans p ON t.plan_id = p.id WHERE t.subscription_status = 'active'
    `);

    res.json({ stats: { ...stats.rows[0], mrr: parseFloat(mrr.rows[0].mrr) } });
  } catch (error) { console.error('Platform stats error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/super-admin/tenants
const getTenants = async (req, res) => {
  try {
    const result = await query(`
      SELECT t.*, p.name as plan_name, p.price,
             (SELECT COUNT(*) FROM users WHERE tenant_id = t.id) as user_count,
             (SELECT COUNT(*) FROM leads WHERE tenant_id = t.id) as lead_count
      FROM tenants t LEFT JOIN plans p ON t.plan_id = p.id
      ORDER BY t.created_at DESC
    `);
    res.json({ tenants: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/super-admin/tenants/:id
const updateTenant = async (req, res) => {
  try {
    const { plan_id, subscription_status, trial_ends_at } = req.body;
    const result = await query(
      `UPDATE tenants SET plan_id = COALESCE($1, plan_id),
       subscription_status = COALESCE($2, subscription_status),
       trial_ends_at = COALESCE($3, trial_ends_at), updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [plan_id, subscription_status, trial_ends_at, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tenant not found.' });
    res.json({ tenant: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/super-admin/tenants/:id/extend-trial
const extendTrial = async (req, res) => {
  try {
    const { days } = req.body;
    const result = await query(
      `UPDATE tenants SET trial_ends_at = COALESCE(trial_ends_at, NOW()) + ($1 || ' days')::INTERVAL
       WHERE id = $2 RETURNING *`,
      [days || 14, req.params.id]
    );
    res.json({ tenant: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/super-admin/tenants/:id/grant-subscription
const grantSubscription = async (req, res) => {
  try {
    const { months, plan_id } = req.body;
    const result = await query(
      `UPDATE tenants SET
       plan_id = COALESCE($1, plan_id),
       subscription_status = 'active',
       subscription_start = CURRENT_DATE,
       subscription_end = CURRENT_DATE + ($2 || ' months')::INTERVAL,
       updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [plan_id || null, months || 1, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tenant not found.' });
    res.json({ tenant: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/super-admin/plans
const getPlans = async (req, res) => {
  try {
    const result = await query('SELECT * FROM plans ORDER BY price ASC');
    res.json({ plans: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getPlatformStats, getTenants, updateTenant, extendTrial, grantSubscription, getPlans };
