const { query } = require('../config/db');

const getPlatformStats = async (req, res) => {
  try {
    const tenants = await query('SELECT COUNT(*) FROM tenants');
    const activeTenants = await query("SELECT COUNT(*) FROM tenants WHERE subscription_status IN ('active','trial')");
    const totalStudents = await query('SELECT COUNT(*) FROM students');
    const totalLeads = await query('SELECT COUNT(*) FROM leads');
    const mrr = await query(`SELECT COALESCE(SUM(p.price),0) as mrr FROM tenants t JOIN plans p ON t.plan_id=p.id WHERE t.subscription_status='active'`);
    const newThisMonth = await query(`SELECT COUNT(*) FROM tenants WHERE created_at >= date_trunc('month', CURRENT_DATE)`);
    const trialCount = await query("SELECT COUNT(*) FROM tenants WHERE subscription_status='trial'");
    const paidCount = await query("SELECT COUNT(*) FROM tenants WHERE subscription_status='active'");
    const expiredCount = await query("SELECT COUNT(*) FROM tenants WHERE subscription_status IN ('expired','cancelled')");
    const planDist = await query(`SELECT p.name, COUNT(t.id) as count FROM tenants t JOIN plans p ON t.plan_id=p.id GROUP BY p.name`);
    const signupTrend = await query(`SELECT TO_CHAR(created_at,'YYYY-MM') as month, COUNT(*) as count FROM tenants WHERE created_at >= CURRENT_DATE - INTERVAL '6 months' GROUP BY TO_CHAR(created_at,'YYYY-MM') ORDER BY month`);

    res.json({
      totalTenants: parseInt(tenants.rows[0].count), activeTenants: parseInt(activeTenants.rows[0].count),
      totalStudents: parseInt(totalStudents.rows[0].count), totalLeads: parseInt(totalLeads.rows[0].count),
      mrr: parseFloat(mrr.rows[0].mrr), newThisMonth: parseInt(newThisMonth.rows[0].count),
      trialCount: parseInt(trialCount.rows[0].count), paidCount: parseInt(paidCount.rows[0].count),
      expiredCount: parseInt(expiredCount.rows[0].count),
      planDistribution: planDist.rows, signupTrend: signupTrend.rows,
    });
  } catch (error) { console.error('Platform stats error:', error); res.status(500).json({ error: 'Failed.' }); }
};

const getTenants = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1'; const params = []; let pi = 1;
    if (status) { where += ` AND t.subscription_status=$${pi++}`; params.push(status); }
    if (search) { where += ` AND (t.name ILIKE $${pi} OR t.email ILIKE $${pi})`; params.push(`%${search}%`); pi++; }

    const countResult = await query(`SELECT COUNT(*) FROM tenants t ${where}`, params);
    const result = await query(
      `SELECT t.*, p.name as plan_name, p.price as plan_price,
              (SELECT COUNT(*) FROM students s WHERE s.tenant_id=t.id) as student_count,
              (SELECT COUNT(*) FROM leads l WHERE l.tenant_id=t.id) as lead_count
       FROM tenants t LEFT JOIN plans p ON t.plan_id=p.id ${where} ORDER BY t.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );
    res.json({ tenants: result.rows, pagination: { total: parseInt(countResult.rows[0].count), page: parseInt(page), pages: Math.ceil(parseInt(countResult.rows[0].count) / limit) } });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

const updateTenant = async (req, res) => {
  try {
    const { subscription_status, plan_id } = req.body;
    const updates = []; const params = []; let pi = 1;
    if (subscription_status) { updates.push(`subscription_status=$${pi++}`); params.push(subscription_status); }
    if (plan_id) { updates.push(`plan_id=$${pi++}`); params.push(plan_id); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    params.push(req.params.id);
    const result = await query(`UPDATE tenants SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ tenant: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

const extendTrial = async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 7;
    const result = await query(
      `UPDATE tenants SET trial_ends_at = COALESCE(trial_ends_at, CURRENT_TIMESTAMP) + INTERVAL '1 day' * $1, subscription_status='trial' WHERE id=$2 RETURNING trial_ends_at`,
      [days, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ message: `Trial extended by ${days} days.`, trial_ends_at: result.rows[0].trial_ends_at });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

const getPlans = async (req, res) => {
  try { const result = await query('SELECT * FROM plans ORDER BY price'); res.json({ plans: result.rows }); }
  catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getPlatformStats, getTenants, updateTenant, extendTrial, getPlans };
