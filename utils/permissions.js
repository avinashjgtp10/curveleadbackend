const { query } = require('../config/db');

// The fixed catalog of permissions the app understands — a code concept,
// not tenant data, so it lives here rather than in a DB table.
const PERMISSIONS = {
  'leads.delete': 'Delete leads',
  'leads.export': 'Export leads to CSV',
  'leads.import': 'Import leads from CSV',
  'leads.bulk_edit': 'Bulk update/delete leads',
  'campaigns.manage': 'Create, edit and delete campaigns',
  'staff.manage': 'Invite, edit and remove team members',
  'settings.manage': 'Change integration and business settings',
  'automations.manage': 'Build automation sequences and rules',
};

// Role defaults, used when a user has no explicit override row for a key.
const ROLE_DEFAULTS = {
  super_admin: Object.keys(PERMISSIONS),
  admin: Object.keys(PERMISSIONS),
  staff: [],
};

// admin/super_admin are always full-access, matching how adminOnly already
// treats them as tenant-superusers — the matrix only customizes staff.
const hasPermission = async (user, key) => {
  if (user.role === 'admin' || user.role === 'super_admin') return true;

  const override = await query(
    'SELECT granted FROM user_permissions WHERE user_id = $1 AND permission_key = $2',
    [user.id, key]
  );
  if (override.rows.length) return override.rows[0].granted;

  return (ROLE_DEFAULTS[user.role] || []).includes(key);
};

const requirePermission = (key) => async (req, res, next) => {
  try {
    if (await hasPermission(req.user, key)) return next();
    res.status(403).json({ error: 'You do not have permission to do this.' });
  } catch (e) {
    console.error('Permission check error:', e.message);
    res.status(500).json({ error: 'Failed.' });
  }
};

module.exports = { PERMISSIONS, ROLE_DEFAULTS, hasPermission, requirePermission };
