const { query } = require('../config/db');
const { signup } = require('./authController');
const { recordDeletion } = require('../utils/accountHistory');

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

    // Snapshot the organization and its users first: the delete cascades and they will be gone afterwards.
    const members = (await query('SELECT name, email, role FROM users WHERE tenant_id = $1 ORDER BY created_at', [req.params.id])).rows;
    const owner = members.find(m => m.role === 'admin') || members[0];

    await query('DELETE FROM tenants WHERE id = $1', [req.params.id]);

    const deletedBy = { id: req.user.id, name: req.user.name, email: req.user.email };
    const orgName = existing.rows[0].name;
    await recordDeletion({ accountType: 'organization', name: orgName, email: owner?.email, role: 'Organization', tenantId: req.params.id, tenantName: orgName, deletedBy, reason: req.body?.reason });
    for (const m of members) {
      await recordDeletion({ accountType: 'user', name: m.name, email: m.email, role: m.role, tenantId: req.params.id, tenantName: orgName, deletedBy, reason: `Deleted with organization "${orgName}"` });
    }
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

// GET /api/super-admin/campaigns/summary — exact platform-wide campaign numbers.
const getCampaignSummary = async (req, res) => {
  try {
    const [counts, leads] = await Promise.all([
      query(`SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE status = 'active') AS active,
                    COUNT(*) FILTER (WHERE status = 'paused') AS paused,
                    COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                    COUNT(*) FILTER (WHERE status = 'draft') AS draft,
                    COALESCE(SUM(actual_spend), 0) AS spend
             FROM campaigns`),
      query(`SELECT COUNT(l.id) AS leads,
                    COUNT(l.id) FILTER (WHERE s.is_won) AS won
             FROM leads l
             LEFT JOIN LATERAL (SELECT is_won FROM lead_stages x WHERE x.tenant_id = l.tenant_id AND LOWER(x.name) = LOWER(l.stage) LIMIT 1) s ON true
             WHERE l.campaign_id IS NOT NULL`),
    ]);
    const n = (v) => parseInt(v, 10) || 0;
    const c = counts.rows[0];
    res.json({
      total: n(c.total), active: n(c.active), paused: n(c.paused), completed: n(c.completed), draft: n(c.draft),
      spend: parseFloat(c.spend) || 0, leads: n(leads.rows[0].leads), won: n(leads.rows[0].won),
    });
  } catch (error) {
    console.error('Campaign summary error:', error);
    res.status(500).json({ error: 'Failed to load the campaign summary.' });
  }
};

// POST /api/super-admin/campaigns   { tenant_id, name, source, description?, budget?, start_date?, end_date?, status? }
// Creates a campaign inside the chosen organization, exactly as that organization's own admin would.
const createCampaign = async (req, res) => {
  try {
    const { tenant_id, name, source, description, budget, start_date, end_date, status = 'active' } = req.body;
    if (!tenant_id || !name?.trim() || !source?.trim()) {
      return res.status(400).json({ error: 'Organization, campaign name and source are required.' });
    }
    if (!CAMPAIGN_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${CAMPAIGN_STATUSES.join(', ')}.` });
    }
    if (budget !== undefined && budget !== '' && !(Number(budget) >= 0)) {
      return res.status(400).json({ error: 'Budget must be a number of 0 or more.' });
    }
    if (start_date && end_date && end_date < start_date) {
      return res.status(400).json({ error: 'End date cannot be before the start date.' });
    }
    const tenant = await query('SELECT name FROM tenants WHERE id = $1', [tenant_id]);
    if (!tenant.rows.length) return res.status(404).json({ error: 'Organization not found.' });

    const result = await query(
      `INSERT INTO campaigns (tenant_id, name, source, description, budget, start_date, end_date, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, tenant_id, name, source, status, budget, start_date, end_date, created_at`,
      [tenant_id, name.trim(), source.trim(), description?.trim() || null, budget === '' || budget === undefined ? 0 : Number(budget),
        start_date || null, end_date || null, status, req.user.id]
    );
    await logActivity({ tenantId: tenant_id, actorName: req.user.name, action: `Campaign "${name.trim()}" created`, module: 'Campaigns' });
    res.status(201).json({ campaign: { ...result.rows[0], tenant_name: tenant.rows[0].name } });
  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({ error: 'Failed to create the campaign.' });
  }
};

// ── Message templates (cross-tenant) ────────────────────────────────────────

// GET /api/super-admin/templates?search=&tenant_id=&channel=&category=&page=&limit=
const getCrossTenantTemplates = async (req, res) => {
  try {
    const { search, tenant_id, channel, category, status, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;
    if (search) { conditions.push(`m.name ILIKE $${i}`); params.push(`%${search}%`); i++; }
    if (tenant_id) { conditions.push(`m.tenant_id = $${i}`); params.push(tenant_id); i++; }
    if (channel) { conditions.push(`m.channel = $${i}`); params.push(channel); i++; }
    if (category) { conditions.push(`m.category = $${i}`); params.push(category); i++; }
    const offset = (Math.max(parseInt(page, 10), 1) - 1) * parseInt(limit, 10);

    // is_active comes from migration_super_admin_features.sql; without it every template counts as active.
    const run = async (hasActiveColumn) => {
      const conds = [...conditions];
      if (hasActiveColumn && status === 'active') conds.push('m.is_active = true');
      if (hasActiveColumn && status === 'inactive') conds.push('m.is_active = false');
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const activeCol = hasActiveColumn ? 'm.is_active' : 'true AS is_active';
      const [rows, count, channels] = await Promise.all([
        query(
          `SELECT m.id, m.name, m.category, m.channel, m.message, m.use_count, ${activeCol}, m.created_at, m.updated_at,
                  m.tenant_id, t.name AS tenant_name
           FROM message_templates m LEFT JOIN tenants t ON t.id = m.tenant_id
           ${where} ORDER BY m.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
          [...params, parseInt(limit, 10), offset]
        ),
        query(`SELECT COUNT(*) FROM message_templates m ${where}`, params),
        query(`SELECT DISTINCT channel FROM message_templates WHERE channel IS NOT NULL ORDER BY channel`),
      ]);
      return { rows, count, channels };
    };
    let out;
    try { out = await run(true); }
    catch (e) { if (e.code !== '42703') throw e; out = await run(false); }
    res.json({
      templates: out.rows.rows,
      total: parseInt(out.count.rows[0].count, 10),
      channels: out.channels.rows.map(r => r.channel),
    });
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to load templates.' });
  }
};

// PUT /api/super-admin/templates/:id   { name?, category?, channel?, message?, is_active? }
const updateTemplate = async (req, res) => {
  try {
    const { name, category, channel, message, is_active } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Template name cannot be empty.' });
    if (message !== undefined && !String(message).trim()) return res.status(400).json({ error: 'Template message cannot be empty.' });
    if (is_active !== undefined && typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false.' });

    const sets = [
      ['name', name?.trim()], ['category', category?.trim()], ['channel', channel?.trim()], ['message', message?.trim()], ['is_active', is_active],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    const assignments = sets.map(([col], idx) => `${col} = $${idx + 1}`).join(', ');
    let result;
    try {
      result = await query(
        `UPDATE message_templates SET ${assignments}, updated_at = NOW() WHERE id = $${sets.length + 1} RETURNING id, name, tenant_id, is_active`,
        [...sets.map(([, v]) => v), req.params.id]
      );
    } catch (e) {
      if (e.code === '42703' && is_active !== undefined) {
        return res.status(503).json({ error: 'Template activation is not set up in the database yet. Run models/migration_super_admin_features.sql.' });
      }
      throw e;
    }
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found.' });
    const t = result.rows[0];
    await logActivity({
      tenantId: t.tenant_id, actorName: req.user.name, module: 'Templates',
      action: is_active === undefined ? `Template "${t.name}" updated` : `Template "${t.name}" ${is_active ? 'activated' : 'deactivated'}`,
    });
    res.json({ template: t });
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ error: 'Failed to update the template.' });
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

module.exports = {
  createTenant, deleteTenant, setCampaignStatus, getCampaignSummary, createCampaign,
  getCrossTenantTemplates, updateTemplate, deleteTemplate,
};
