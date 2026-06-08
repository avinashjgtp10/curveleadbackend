const bcrypt = require('bcryptjs');
const { query } = require('../config/db');

// GET /api/staff
const getStaff = async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.is_active, u.last_login, u.created_at,
              (SELECT COUNT(*) FROM leads WHERE assigned_to = u.id) as assigned_leads,
              (SELECT COUNT(*) FROM leads WHERE assigned_to = u.id AND stage = 'won') as won_leads
       FROM users u WHERE u.tenant_id = $1 ORDER BY u.created_at DESC`,
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
    const allowedFields = ['name', 'phone', 'role', 'is_active'];
    const updates = [];
    const params = [req.params.id, req.tenantId];
    let i = 3;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${i++}`);
        params.push(req.body[field]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2
       RETURNING id, name, email, phone, role, is_active`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staff not found.' });
    res.json({ user: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/staff/:id
const deleteStaff = async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself.' });

    // Unassign leads first
    await query('UPDATE leads SET assigned_to = NULL WHERE assigned_to = $1', [req.params.id]);
    await query('UPDATE followups SET assigned_to = NULL WHERE assigned_to = $1', [req.params.id]);

    const result = await query('DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staff not found.' });
    res.json({ message: 'Deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getStaff, createStaff, updateStaff, deleteStaff };
