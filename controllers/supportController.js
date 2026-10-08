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
    const result = await query('SELECT id, tenant_id FROM users WHERE id = $1', [decoded.userId]);
    return result.rows[0] || null;
  } catch { return null; }
};

// POST /api/support/tickets
// Required: name, email, message. Optional: phone, subject, category, priority (low | medium | high).
const submitTicket = async (req, res) => {
  try {
    const { name, email, phone, message, subject, category, priority } = req.body;
    if (!name?.trim() || !email?.trim() || !message?.trim()) {
      return res.status(400).json({ error: 'Name, email and message are required.' });
    }
    const normalizedPriority = PRIORITIES.includes(String(priority || '').toLowerCase()) ? String(priority).toLowerCase() : null;
    if (priority && !normalizedPriority) {
      return res.status(400).json({ error: `priority must be one of: ${PRIORITIES.join(', ')}.` });
    }
    const user = await userFromToken(req);
    const tenantId = user?.tenant_id || null;

    let result;
    try {
      result = await query(
        `INSERT INTO support_tickets (tenant_id, created_by, name, email, phone, message, subject, category, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [tenantId, user?.id || null, name.trim(), email.trim(), phone?.trim() || null, message.trim(), subject?.trim() || null, category?.trim() || null, normalizedPriority]
      );
    } catch (e) {
      if (e.code !== '42703') throw e; // columns not migrated yet: store the original fields
      result = await query(
        `INSERT INTO support_tickets (tenant_id, name, email, phone, message) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, name.trim(), email.trim(), phone?.trim() || null, message.trim()]
      );
    }
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) { console.error('Submit support ticket error:', error); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { submitTicket };
