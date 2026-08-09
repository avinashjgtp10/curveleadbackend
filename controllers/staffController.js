const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../config/db');
const { sendInviteEmail } = require('../utils/email');
const { PERMISSIONS, ROLE_DEFAULTS } = require('../utils/permissions');

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sendInvite = async ({ tenantId, tenantName, inviterName, invitedBy, email, name, role, teamId }) => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);

  const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/accept-invite?token=${token}`;
  await sendInviteEmail(email, inviteUrl, tenantName, inviterName).catch(e => console.error('Invite email failed:', e.message));

  return query(
    `INSERT INTO invitations (tenant_id, email, name, role, team_id, token, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenantId, email, name || null, role || 'staff', teamId || null, token, invitedBy || null, expiresAt]
  );
};

// GET /api/staff
const getStaff = async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.is_active, u.last_login, u.created_at,
              u.team_id, t.name as team_name,
              (SELECT COUNT(*) FROM leads WHERE assigned_to = u.id) as assigned_leads,
              (SELECT COUNT(*) FROM leads WHERE assigned_to = u.id AND stage = 'won') as won_leads
       FROM users u
       LEFT JOIN teams t ON t.id = u.team_id
       WHERE u.tenant_id = $1 ORDER BY u.created_at DESC`,
      [req.tenantId]
    );
    res.json({ staff: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/staff - Invite/create staff
const createStaff = async (req, res) => {
  try {
    const { name, email, phone, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Required fields missing.' });

    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already exists.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (tenant_id, name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, phone, role, is_active`,
      [req.tenantId, name, email, phone, passwordHash, role || 'staff']
    );

    res.status(201).json({ user: result.rows[0] });
  } catch (error) { console.error('Create staff error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/staff/:id
const updateStaff = async (req, res) => {
  try {
    const allowedFields = ['name', 'phone', 'role', 'is_active', 'team_id'];
    const updates = [];
    const params = [req.params.id, req.tenantId];
    let i = 3;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${i++}`);
        params.push(field === 'team_id' ? (req.body[field] || null) : req.body[field]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2
       RETURNING id, name, email, phone, role, is_active, team_id`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staff not found.' });
    res.json({ user: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/staff/invite - Real invite: email a link, account created on accept
const inviteStaff = async (req, res) => {
  try {
    const { name, email, role, team_id } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) return res.status(409).json({ error: 'Email already exists.' });

    const pending = await query(
      `SELECT id FROM invitations WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL AND expires_at > NOW()`,
      [req.tenantId, email]
    );
    if (pending.rows.length > 0) return res.status(409).json({ error: 'An invite is already pending for this email.' });

    const tenantRes = await query('SELECT name FROM tenants WHERE id = $1', [req.tenantId]);

    const result = await sendInvite({
      tenantId: req.tenantId, tenantName: tenantRes.rows[0]?.name || 'CurveLead',
      inviterName: req.user.name, invitedBy: req.user.id,
      email, name, role, teamId: team_id,
    });

    res.status(201).json({ invitation: result.rows[0] });
  } catch (error) { console.error('Invite staff error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/staff/invitations - Pending invites
const getInvitations = async (req, res) => {
  try {
    const result = await query(
      `SELECT i.*, t.name as team_name FROM invitations i
       LEFT JOIN teams t ON t.id = i.team_id
       WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.expires_at > NOW()
       ORDER BY i.created_at DESC`,
      [req.tenantId]
    );
    res.json({ invitations: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/staff/invitations/:id/resend
const resendInvitation = async (req, res) => {
  try {
    const existing = await query('SELECT * FROM invitations WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL', [req.params.id, req.tenantId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Invitation not found.' });
    const inv = existing.rows[0];

    const tenantRes = await query('SELECT name FROM tenants WHERE id = $1', [req.tenantId]);
    await query('DELETE FROM invitations WHERE id = $1', [inv.id]);

    const result = await sendInvite({
      tenantId: req.tenantId, tenantName: tenantRes.rows[0]?.name || 'CurveLead',
      inviterName: req.user.name, invitedBy: req.user.id,
      email: inv.email, name: inv.name, role: inv.role, teamId: inv.team_id,
    });

    res.json({ invitation: result.rows[0] });
  } catch (error) { console.error('Resend invite error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/staff/invitations/:id - Revoke
const revokeInvitation = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM invitations WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL RETURNING id',
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invitation not found.' });
    res.json({ message: 'Revoked.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/staff/:id/permissions - Effective permission set (overrides + role defaults)
const getUserPermissions = async (req, res) => {
  try {
    const userRes = await query('SELECT role FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'Staff not found.' });
    const role = userRes.rows[0].role;

    const overridesRes = await query(
      'SELECT permission_key, granted FROM user_permissions WHERE user_id = $1',
      [req.params.id]
    );
    const overrides = Object.fromEntries(overridesRes.rows.map(r => [r.permission_key, r.granted]));
    const defaults = ROLE_DEFAULTS[role] || [];

    const permissions = Object.keys(PERMISSIONS).map(key => ({
      key,
      label: PERMISSIONS[key],
      granted: key in overrides ? overrides[key] : defaults.includes(key),
    }));

    res.json({ role, permissions });
  } catch (error) { console.error('Get permissions error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/staff/:id/permissions - body: { permissions: { 'leads.delete': true, ... } }
const updateUserPermissions = async (req, res) => {
  try {
    const { permissions } = req.body;
    if (!permissions || typeof permissions !== 'object') return res.status(400).json({ error: 'permissions object required.' });

    const userRes = await query('SELECT id FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'Staff not found.' });

    for (const [key, granted] of Object.entries(permissions)) {
      if (!(key in PERMISSIONS)) continue;
      await query(
        `INSERT INTO user_permissions (tenant_id, user_id, permission_key, granted)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = EXCLUDED.granted`,
        [req.tenantId, req.params.id, key, !!granted]
      );
    }

    res.json({ message: 'Permissions updated.' });
  } catch (error) { console.error('Update permissions error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// Shared by the self-service ("me") and admin-managed WhatsApp number endpoints.
const fetchWhatsAppNumber = async (userId, tenantId) => {
  const result = await query(
    'SELECT whatsapp_phone_number_id, whatsapp_access_token FROM users WHERE id = $1 AND tenant_id = $2',
    [userId, tenantId]
  );
  if (!result.rows.length) return null;
  const { whatsapp_phone_number_id, whatsapp_access_token } = result.rows[0];
  return {
    whatsapp_phone_number_id: whatsapp_phone_number_id || '',
    whatsapp_access_token: whatsapp_access_token ? '••••••••' : '',
    configured: !!(whatsapp_phone_number_id && whatsapp_access_token),
  };
};

const saveWhatsAppNumber = async (userId, tenantId, { whatsapp_phone_number_id, whatsapp_access_token }) => {
  const sets = [];
  const params = [];
  let i = 1;
  if (whatsapp_phone_number_id !== undefined) { sets.push(`whatsapp_phone_number_id = $${i++}`); params.push(whatsapp_phone_number_id || null); }
  if (whatsapp_access_token && !whatsapp_access_token.startsWith('•')) { sets.push(`whatsapp_access_token = $${i++}`); params.push(whatsapp_access_token); }
  if (!sets.length) return { rowCount: 0 };
  params.push(userId, tenantId);
  return query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING id`, params);
};

// GET /api/staff/me/whatsapp-number
const getMyWhatsAppNumber = async (req, res) => {
  try {
    const config = await fetchWhatsAppNumber(req.user.id, req.tenantId);
    res.json(config);
  } catch (error) { console.error('Get my WhatsApp number error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/staff/me/whatsapp-number
const updateMyWhatsAppNumber = async (req, res) => {
  try {
    const result = await saveWhatsAppNumber(req.user.id, req.tenantId, req.body);
    if (!result.rowCount) return res.status(400).json({ error: 'No fields to update.' });
    res.json({ message: 'WhatsApp number saved.' });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That WhatsApp number is already connected to another team member.' });
    console.error('Update my WhatsApp number error:', error); res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/staff/:id/whatsapp-number
const getStaffWhatsAppNumber = async (req, res) => {
  try {
    const config = await fetchWhatsAppNumber(req.params.id, req.tenantId);
    if (!config) return res.status(404).json({ error: 'Staff not found.' });
    res.json(config);
  } catch (error) { console.error('Get staff WhatsApp number error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/staff/:id/whatsapp-number
const updateStaffWhatsAppNumber = async (req, res) => {
  try {
    const result = await saveWhatsAppNumber(req.params.id, req.tenantId, req.body);
    if (!result.rowCount) return res.status(404).json({ error: 'Staff not found, or no fields to update.' });
    res.json({ message: 'WhatsApp number saved.' });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That WhatsApp number is already connected to another team member.' });
    console.error('Update staff WhatsApp number error:', error); res.status(500).json({ error: 'Failed.' });
  }
};

// DELETE /api/staff/:id
const deleteStaff = async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself.' });

    const userId = req.params.id;
    // Unassign leads and followups before deleting (ON DELETE SET NULL handles created_by columns)
    await query('UPDATE leads SET assigned_to = NULL WHERE assigned_to = $1', [userId]);
    await query('UPDATE followups SET assigned_to = NULL WHERE assigned_to = $1', [userId]);

    const result = await query('DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [userId, req.tenantId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staff not found.' });
    res.json({ message: 'Deleted.' });
  } catch (error) { console.error('Delete staff error:', error); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = {
  getStaff, createStaff, updateStaff, deleteStaff, inviteStaff, getInvitations, resendInvitation, revokeInvitation,
  getUserPermissions, updateUserPermissions,
  getMyWhatsAppNumber, updateMyWhatsAppNumber, getStaffWhatsAppNumber, updateStaffWhatsAppNumber,
};
