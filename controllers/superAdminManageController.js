const { query } = require('../config/db');
const { signup } = require('./authController');

const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed'];
const TENANT_STATUSES = ['trial', 'active', 'cancelled', 'expired', 'halted'];

// Mirrors the logger in superAdminController: never throws, so a logging failure cannot break the action.
const logActivity = async ({ tenantId, actorName, action, module, status = 'Success' }) => {
  try {
    await query(
      `INSERT INTO activity_logs (tenant_id, actor_name, action, module, status) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId || null, actorName || 'Super Admin', action, module, status]
    );
  } catch (e) { console.error('Activity log error:', e.message); }
};

// ── Organizations ───────────────────────────────────────────────────────────

// POST /api/super-admin/tenants
// Creates an organization + its first admin through the exact same code path as public signup
// (default stages, statuses, 14-day trial), then optionally applies a plan / status.
const createTenant = async (req, res) => {
  try {
    const { businessName, name, email, phone, password, businessType, plan_id, subscription_status } = req.body;
    if (subscription_status && !TENANT_STATUSES.includes(subscription_status)) {
      return res.status(400).json({ error: `subscription_status must be one of: ${TENANT_STATUSES.join(', ')}.` });
    }

    // Reuse signup() without an HTTP round trip by capturing what it would have sent.
    const outcome = await new Promise((resolve) => {
      let code = 200;
      const capture = { status(c) { code = c; return capture; }, json(body) { resolve({ code, body }); } };
      signup({ body: { businessName, name, email, phone, password, businessType } }, capture);
    });
    if (outcome.code >= 400) return res.status(outcome.code).json(outcome.body);

    const tenantId = outcome.body.tenant.id;
    if (plan_id || subscription_status) {
      await query(
        `UPDATE tenants SET plan_id = COALESCE($1, plan_id), subscription_status = COALESCE($2, subscription_status), updated_at = NOW() WHERE id = $3`,
        [plan_id || null, subscription_status || null, tenantId]
      );
    }
    await logActivity({ tenantId, actorName: req.user.name, action: 'Organization created', module: 'Workspaces' });

    const created = await query(
      `SELECT t.*, p.name AS plan_name FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [tenantId]
    );
    // The signup token belongs to the new owner, not the Super Admin — deliberately not returned.
    res.status(201).json({ tenant: created.rows[0] });
  } catch (error) {
    console.error('Create tenant error:', error);
    res.status(500).json({ error: 'Failed to create organization.' });
  }
};

// DELETE /api/super-admin/tenants/:id
// Permanently removes an organization and everything cascading from it. The Super Admin's own
// organization cannot be deleted.
const deleteTenant = async (req, res) => {
  try {
    if (req.params.id === req.user.tenant_id) {
      return res.status(400).json({ error: 'You cannot delete the organization your own account belongs to.' });
    }
    const existing = await query('SELECT name FROM tenants WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Organization not found.' });

    await query('DELETE FROM tenants WHERE id = $1', [req.params.id]);
    await logActivity({ tenantId: null, actorName: req.user.name, action: `Organization deleted: ${existing.rows[0].name}`, module: 'Workspaces', status: 'Warning' });
    res.json({ message: 'Organization deleted.' });
  } catch (error) {
    // 23503 = foreign_key_violation: some table still references this tenant without ON DELETE CASCADE.
    if (error.code === '23503') {
      return res.status(409).json({ error: 'This organization still has linked records that block deletion. Suspend it instead.' });
    }
    console.error('Delete tenant error:', error);
    res.status(500).json({ error: 'Failed to delete organization.' });
  }
};

// ── Campaigns ───────────────────────────────────────────────────────────────

// PUT /api/super-admin/campaigns/:id/status   { status }
// Changes a campaign's status in CurveLead. It does not call the ad platform, so a paused
// campaign keeps running on Meta/Google until paused there.
const setCampaignStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!CAMPAIGN_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${CAMPAIGN_STATUSES.join(', ')}.` });
    }
    const result = await query(
      `UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, tenant_id, status`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Campaign not found.' });

    const c = result.rows[0];
    await logActivity({
      tenantId: c.tenant_id, actorName: req.user.name, module: 'Campaigns',
      action: `Campaign "${c.name}" ${status === 'paused' ? 'paused' : status === 'active' ? 'resumed' : `set to ${status}`}`,
    });
    res.json({ campaign: c });
  } catch (error) {
    console.error('Set campaign status error:', error);
    res.status(500).json({ error: 'Failed to update campaign.' });
  }
};

// ── Message templates (cross-tenant) ────────────────────────────────────────

// GET /api/super-admin/templates?search=&tenant_id=&channel=&category=&page=&limit=
const getCrossTenantTemplates = async (req, res) => {
  try {
    const { search, tenant_id, channel, category, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;
    if (search) { conditions.push(`m.name ILIKE $${i}`); params.push(`%${search}%`); i++; }
    if (tenant_id) { conditions.push(`m.tenant_id = $${i}`); params.push(tenant_id); i++; }
    if (channel) { conditions.push(`m.channel = $${i}`); params.push(channel); i++; }
    if (category) { conditions.push(`m.category = $${i}`); params.push(category); i++; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (Math.max(parseInt(page, 10), 1) - 1) * parseInt(limit, 10);

    const [rows, count, channels] = await Promise.all([
      query(
        `SELECT m.id, m.name, m.category, m.channel, m.message, m.use_count, m.created_at, m.updated_at,
                m.tenant_id, t.name AS tenant_name
         FROM message_templates m LEFT JOIN tenants t ON t.id = m.tenant_id
         ${where} ORDER BY m.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...params, parseInt(limit, 10), offset]
      ),
      query(`SELECT COUNT(*) FROM message_templates m ${where}`, params),
      query(`SELECT DISTINCT channel FROM message_templates WHERE channel IS NOT NULL ORDER BY channel`),
    ]);
    res.json({
      templates: rows.rows,
      total: parseInt(count.rows[0].count, 10),
      channels: channels.rows.map(r => r.channel),
    });
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to load templates.' });
  }
};

// DELETE /api/super-admin/templates/:id
const deleteTemplate = async (req, res) => {
  try {
    const result = await query('DELETE FROM message_templates WHERE id = $1 RETURNING name, tenant_id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found.' });
    await logActivity({ tenantId: result.rows[0].tenant_id, actorName: req.user.name, action: `Template "${result.rows[0].name}" deleted`, module: 'Templates', status: 'Warning' });
    res.json({ message: 'Template deleted.' });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Failed to delete template.' });
  }
};

module.exports = { createTenant, deleteTenant, setCampaignStatus, getCrossTenantTemplates, deleteTemplate };
