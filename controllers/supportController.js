const { query } = require('../config/db');

// POST /api/support/tickets — public, no auth (submitted from the Contact Us page)
const submitTicket = async (req, res) => {
  try {
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

module.exports = { submitTicket };
