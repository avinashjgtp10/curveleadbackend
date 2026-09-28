const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const TICKET_CATEGORIES = ['General', 'Technical', 'Billing', 'Feature Request', 'Bug Report'];
const TICKET_PRIORITIES = ['low', 'medium', 'high'];

// Resolves the logged-in user from the Authorization header, if any — lets this
// endpoint serve both the public Contact Us form (no auth) and the in-app
// "Submit a Request" form on the Help & Support page (authenticated tenant user).
const resolveUser = async (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    const result = await query('SELECT id, name, email, tenant_id FROM users WHERE id = $1', [decoded.userId]);
    return result.rows[0] || null;
  } catch {
    return null;
  }
};

// POST /api/support/tickets
const submitTicket = async (req, res) => {
  try {
    const user = await resolveUser(req);

    if (user) {
      const { subject, category = 'General', priority = 'medium', message } = req.body;
      if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required.' });
      if (!message?.trim()) return res.status(400).json({ error: 'Please describe your issue.' });
      if (!TICKET_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
      if (!TICKET_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority.' });

      const result = await query(
        `INSERT INTO support_tickets (tenant_id, created_by, name, email, subject, category, priority, message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [user.tenant_id, user.id, user.name, user.email, subject.trim(), category, priority, message.trim()]
      );
      return res.status(201).json({ id: result.rows[0].id });
    }

    // Public submission from the marketing site's Contact Us page
    const { name, email, phone, message } = req.body;
    if (!name?.trim() || !email?.trim() || !message?.trim()) {
      return res.status(400).json({ error: 'Name, email and message are required.' });
    }
    const result = await query(
      `INSERT INTO support_tickets (name, email, phone, message) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name.trim(), email.trim(), phone?.trim() || null, message.trim()]
    );
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
