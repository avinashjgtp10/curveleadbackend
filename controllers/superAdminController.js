const { query } = require('../config/db');

// Records a row in activity_logs for the Super Admin activity feed. Never
// throws — a logging failure should not break the action that triggered it.
const logActivity = async ({ tenantId, actorName, action, module, status = 'Success' }) => {
  try {
    await query(
      `INSERT INTO activity_logs (tenant_id, actor_name, action, module, status) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId || null, actorName || 'Super Admin', action, module, status]
    );
  } catch (e) { console.error('Activity log error:', e.message); }
};

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
        (SELECT COALESCE(SUM(actual_spend), 0) FROM campaigns) as total_campaign_spend,
        (SELECT COUNT(*) FROM invitations WHERE accepted_at IS NULL AND expires_at > NOW()) as pending_invitations
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
             (SELECT COUNT(*) FROM leads WHERE tenant_id = t.id) as lead_count,
             (SELECT u.name FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin' ORDER BY u.created_at ASC LIMIT 1) as owner_name,
             (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin' ORDER BY u.created_at ASC LIMIT 1) as owner_email,
             (SELECT u.phone FROM users u WHERE u.tenant_id = t.id AND u.role = 'admin' ORDER BY u.created_at ASC LIMIT 1) as owner_phone
      FROM tenants t LEFT JOIN plans p ON t.plan_id = p.id
      ORDER BY t.created_at DESC
    `);
    res.json({ tenants: result.rows });
  } catch (error) { console.error('Get tenants error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/super-admin/tenants/:id
const updateTenant = async (req, res) => {
  try {
    const { plan_id, subscription_status, trial_ends_at } = req.body;
    const before = await query('SELECT name, subscription_status, plan_id FROM tenants WHERE id = $1', [req.params.id]);
    const result = await query(
      `UPDATE tenants SET plan_id = COALESCE($1, plan_id),
       subscription_status = COALESCE($2, subscription_status),
       trial_ends_at = COALESCE($3, trial_ends_at), updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [plan_id, subscription_status, trial_ends_at, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Tenant not found.' });

    const b = before.rows[0];
    if (plan_id && plan_id !== b?.plan_id) {
      await logActivity({ tenantId: req.params.id, actorName: req.user.name, action: 'Plan changed', module: 'Subscriptions' });
    }
    if (subscription_status && subscription_status !== b?.subscription_status) {
      await logActivity({
        tenantId: req.params.id, actorName: req.user.name,
        action: subscription_status === 'active' ? 'Subscription reactivated' : subscription_status === 'cancelled' ? 'Subscription cancelled' : `Status changed to ${subscription_status}`,
        module: 'Subscriptions', status: subscription_status === 'cancelled' ? 'Warning' : 'Success',
      });
    }
    res.json({ tenant: result.rows[0] });
  } catch (error) { console.error('Update tenant error:', error); res.status(500).json({ error: 'Failed.' }); }
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
    await logActivity({ tenantId: req.params.id, actorName: req.user.name, action: `Trial extended by ${days || 14} days`, module: 'Subscriptions' });
    res.json({ tenant: result.rows[0] });
  } catch (error) { console.error('Extend trial error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/super-admin/plans
const getPlans = async (req, res) => {
  try {
    const result = await query('SELECT * FROM plans ORDER BY price ASC');
    res.json({ plans: result.rows });
  } catch (error) { console.error('Get plans error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/super-admin/plans
const createPlan = async (req, res) => {
  try {
    const { name, price, max_leads, max_users, features } = req.body;
    if (!name) return res.status(400).json({ error: 'Plan name is required.' });
    const result = await query(
      `INSERT INTO plans (name, price, max_leads, max_users, features, is_active)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
      [name, price || 0, max_leads ?? 0, max_users ?? 1, features || {}]
    );
    await logActivity({ actorName: req.user.name, action: `Plan "${name}" created`, module: 'Plans' });
    res.status(201).json({ plan: result.rows[0] });
  } catch (error) { console.error('Create plan error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/super-admin/plans/:id
const updatePlan = async (req, res) => {
  try {
    const { name, price, max_leads, max_users, features, is_active } = req.body;
    const result = await query(
      `UPDATE plans SET
        name = COALESCE($1, name), price = COALESCE($2, price),
        max_leads = COALESCE($3, max_leads), max_users = COALESCE($4, max_users),
        features = COALESCE($5, features), is_active = COALESCE($6, is_active)
       WHERE id = $7 RETURNING *`,
      [name, price, max_leads, max_users, features, is_active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Plan not found.' });
    await logActivity({ actorName: req.user.name, action: `Plan "${result.rows[0].name}" updated`, module: 'Plans' });
    res.json({ plan: result.rows[0] });
  } catch (error) { console.error('Update plan error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// ============================================
// Users (cross-tenant)
// ============================================

// GET /api/super-admin/users
const getUsers = async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login, u.created_at,
             t.id as tenant_id, t.name as tenant_name
      FROM users u LEFT JOIN tenants t ON u.tenant_id = t.id
      ORDER BY u.created_at DESC
    `);
    res.json({ users: result.rows });
  } catch (error) { console.error('Get users error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/super-admin/users/:id - body: { role } and/or { is_active }
const updateUser = async (req, res) => {
  try {
    const { role, is_active } = req.body;
    const result = await query(
      `UPDATE users SET role = COALESCE($1, role), is_active = COALESCE($2, is_active)
       WHERE id = $3 RETURNING id, name, email, role, is_active, tenant_id`,
      [role, is_active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
    const u = result.rows[0];
    if (role) await logActivity({ tenantId: u.tenant_id, actorName: req.user.name, action: `Role changed to ${role} for ${u.name}`, module: 'Users' });
    if (is_active !== undefined) await logActivity({ tenantId: u.tenant_id, actorName: req.user.name, action: `${u.name} ${is_active ? 'activated' : 'suspended'}`, module: 'Users', status: is_active ? 'Success' : 'Warning' });
    res.json({ user: u });
  } catch (error) { console.error('Update user error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/super-admin/users/:id
const deleteUser = async (req, res) => {
  try {
    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id, name, tenant_id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
    await logActivity({ tenantId: result.rows[0].tenant_id, actorName: req.user.name, action: `${result.rows[0].name} removed`, module: 'Users', status: 'Warning' });
    res.json({ message: 'Removed.' });
  } catch (error) { console.error('Delete user error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// ============================================
// Leads (cross-tenant)
// ============================================

// GET /api/super-admin/leads?search=&tenant_id=&source=&stage=&score=&page=&limit=
const getCrossTenantLeads = async (req, res) => {
  try {
    const { search, tenant_id, source, stage, score, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;

    if (search) { conditions.push(`(l.name ILIKE $${i} OR l.phone ILIKE $${i} OR l.email ILIKE $${i})`); params.push(`%${search}%`); i++; }
    if (tenant_id) { conditions.push(`l.tenant_id = $${i}`); params.push(tenant_id); i++; }
    if (source) { conditions.push(`l.source = $${i}`); params.push(source); i++; }
    if (stage) { conditions.push(`l.stage = $${i}`); params.push(stage); i++; }
    if (score) { conditions.push(`l.lead_score = $${i}`); params.push(score); i++; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

    const result = await query(
      `SELECT l.id, l.lead_number, l.name, l.phone, l.email, l.source, l.stage, l.lead_score, l.created_at,
              t.id as tenant_id, t.name as tenant_name,
              u.name as assigned_to_name
       FROM leads l
       LEFT JOIN tenants t ON l.tenant_id = t.id
       LEFT JOIN users u ON l.assigned_to = u.id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    );
    const countResult = await query(`SELECT COUNT(*) FROM leads l ${where}`, params);

    res.json({ leads: result.rows, total: parseInt(countResult.rows[0].count, 10) });
  } catch (error) { console.error('Get cross-tenant leads error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// ============================================
// Billing
// ============================================

// GET /api/super-admin/billing/summary
const getBillingSummary = async (req, res) => {
  try {
    const result = await query(`
      SELECT
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status = 'paid') as total_revenue,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status = 'paid' AND paid_at >= date_trunc('month', NOW())) as monthly_revenue,
        (SELECT COUNT(*) FROM invoices WHERE status = 'paid') as successful_payments,
        (SELECT COUNT(*) FROM invoices WHERE status = 'failed') as failed_payments,
        (SELECT COUNT(*) FROM invoices WHERE status = 'refunded') as refunded_payments,
        (SELECT COUNT(*) FROM invoices WHERE status = 'pending') as pending_payments
    `);
    res.json({ summary: result.rows[0] });
  } catch (error) { console.error('Billing summary error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/super-admin/billing/workspace-revenue
const getWorkspaceRevenue = async (req, res) => {
  try {
    const result = await query(`
      SELECT t.id as tenant_id, t.name as workspace, COALESCE(SUM(i.total), 0) as revenue
      FROM tenants t LEFT JOIN invoices i ON i.tenant_id = t.id AND i.status = 'paid'
      GROUP BY t.id, t.name
      ORDER BY revenue DESC
    `);
    res.json({ revenue: result.rows });
  } catch (error) { console.error('Workspace revenue error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/super-admin/billing/payments
const getPaymentHistory = async (req, res) => {
  try {
    const result = await query(`
      SELECT i.id, i.amount, i.total, i.status, i.paid_at, i.created_at,
             t.name as workspace
      FROM invoices i LEFT JOIN tenants t ON i.tenant_id = t.id
      ORDER BY i.created_at DESC LIMIT 100
    `);
    res.json({ payments: result.rows });
  } catch (error) { console.error('Payment history error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// ============================================
// Activity Logs
// ============================================

// GET /api/super-admin/activity-logs?module=&status=&search=
const getActivityLogs = async (req, res) => {
  try {
    const { module, status, search } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;

    if (module) { conditions.push(`al.module = $${i}`); params.push(module); i++; }
    if (status) { conditions.push(`al.status = $${i}`); params.push(status); i++; }
    if (search) { conditions.push(`(al.actor_name ILIKE $${i} OR al.action ILIKE $${i} OR t.name ILIKE $${i})`); params.push(`%${search}%`); i++; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(
      `SELECT al.id, al.actor_name, al.action, al.module, al.status, al.created_at, t.name as workspace
       FROM activity_logs al LEFT JOIN tenants t ON al.tenant_id = t.id
       ${where}
       ORDER BY al.created_at DESC LIMIT 200`,
      params
    );
    res.json({ logs: result.rows });
  } catch (error) { console.error('Activity logs error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// ============================================
// Dashboard trend charts
// ============================================

// GET /api/super-admin/trends/workspace-growth - tenants created per month, last 6 months
const getWorkspaceGrowthTrend = async (req, res) => {
  try {
    const result = await query(`
      SELECT month_start, to_char(month_start, 'Mon') as month, COUNT(t.id) as workspaces
      FROM generate_series(date_trunc('month', NOW()) - interval '5 months', date_trunc('month', NOW()), interval '1 month') month_start
      LEFT JOIN tenants t ON date_trunc('month', t.created_at) = month_start
      GROUP BY month_start ORDER BY month_start
    `);
    res.json({ trend: result.rows.map(r => ({ month: r.month, workspaces: parseInt(r.workspaces, 10) })) });
  } catch (error) { console.error('Workspace growth trend error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/super-admin/trends/leads - leads created per day, last 7 days
const getLeadsTrendData = async (req, res) => {
  try {
    const result = await query(`
      SELECT day_start, to_char(day_start, 'DD Mon') as day, COUNT(l.id) as leads
      FROM generate_series(date_trunc('day', NOW()) - interval '6 days', date_trunc('day', NOW()), interval '1 day') day_start
      LEFT JOIN leads l ON date_trunc('day', l.created_at) = day_start
      GROUP BY day_start ORDER BY day_start
    `);
    res.json({ trend: result.rows.map(r => ({ day: r.day, leads: parseInt(r.leads, 10) })) });
  } catch (error) { console.error('Leads trend error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/super-admin/trends/revenue - paid invoice total per month, last 6 months
const getRevenueTrendData = async (req, res) => {
  try {
    const result = await query(`
      SELECT month_start, to_char(month_start, 'Mon') as month, COALESCE(SUM(i.total), 0) as revenue
      FROM generate_series(date_trunc('month', NOW()) - interval '5 months', date_trunc('month', NOW()), interval '1 month') month_start
      LEFT JOIN invoices i ON date_trunc('month', i.paid_at) = month_start AND i.status = 'paid'
      GROUP BY month_start ORDER BY month_start
    `);
    res.json({ trend: result.rows.map(r => ({ month: r.month, revenue: parseFloat(r.revenue) })) });
  } catch (error) { console.error('Revenue trend error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// ============================================
// Automations (cross-tenant)
// ============================================

// GET /api/super-admin/automations
const getAutomations = async (req, res) => {
  try {
    const result = await query(`
      SELECT s.id, s.name, s.description, s.is_active, s.created_at,
             t.id as tenant_id, t.name as tenant_name,
             (SELECT COUNT(*) FROM automation_sequence_steps WHERE sequence_id = s.id) as step_count
      FROM automation_sequences s
      LEFT JOIN tenants t ON s.tenant_id = t.id
      ORDER BY s.created_at DESC
    `);
    res.json({ automations: result.rows });
  } catch (error) { console.error('Get automations error:', error); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = {
  getPlatformStats, getTenants, updateTenant, extendTrial,
  getPlans, createPlan, updatePlan,
  getUsers, updateUser, deleteUser,
  getCrossTenantLeads,
  getBillingSummary, getWorkspaceRevenue, getPaymentHistory,
  getActivityLogs,
  getWorkspaceGrowthTrend, getLeadsTrendData, getRevenueTrendData,
  getAutomations,
};
