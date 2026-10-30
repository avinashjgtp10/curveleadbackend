const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const PRIORITIES = ['low', 'medium', 'high'];

// The route is public (Contact Us page), but a signed-in user's request also carries their token.
// If it is valid, link the ticket to that user and their organization; otherwise leave it unlinked.
const userFromToken = async (req) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const result = await query('SELECT id, tenant_id, name, email FROM users WHERE id = $1', [decoded.userId]);
    return result.rows[0] || null;
  } catch { return null; }
};

// POST /api/support/tickets
// Required: name, email, message. Optional: phone, subject, category, priority (low | medium | high).
const submitTicket = async (req, res) => {
  try {
    const { phone, message, subject, category, priority } = req.body;
    const user = await userFromToken(req);
    // A signed-in user's name and email come from their account, so the in-app forms don't have to send them.
    const name = req.body.name?.trim() || user?.name;
    const email = req.body.email?.trim() || user?.email;
    if (!name?.trim() || !email?.trim() || !message?.trim()) {
      return res.status(400).json({ error: 'Name, email and message are required.' });
    }
    const normalizedPriority = PRIORITIES.includes(String(priority || '').toLowerCase()) ? String(priority).toLowerCase() : null;
    if (priority && !normalizedPriority) {
      return res.status(400).json({ error: `priority must be one of: ${PRIORITIES.join(', ')}.` });
    }
    const tenantId = user?.tenant_id || null;

    let result;
    try {
      result = await query(
        `INSERT INTO support_tickets (tenant_id, created_by, name, email, phone, message, subject, category, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [tenantId, user?.id || null, name.trim(), email.trim(), phone?.trim() || null, message.trim(), subject?.trim() || null, category?.trim() || null, normalizedPriority]
      );
    } catch (e) {
      // Columns not migrated yet, or the database rejected the extra fields: still store the original fields
      // rather than losing the request.
      console.warn('Support ticket full insert failed, saving basic fields:', e.code, e.message);
      result = await query(
        `INSERT INTO support_tickets (tenant_id, name, email, phone, message) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, name.trim(), email.trim(), phone?.trim() || null, message.trim()]
      );
    }
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) { console.error('Submit support ticket error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/support/tickets — the logged-in user's own tickets
const getMyTickets = async (req, res) => {
  try {
    const result = await query(
      `SELECT id, subject, category, priority, status, created_at, updated_at
       FROM support_tickets
       WHERE tenant_id = $1 AND created_by = $2
       ORDER BY created_at DESC`,
      [req.tenantId, req.user.id]
    );
    res.json({ tickets: result.rows });
  } catch (error) { console.error('Get my tickets error:', error); res.status(500).json({ error: 'Failed to fetch tickets.' }); }
};

module.exports = { submitTicket, getMyTickets };
