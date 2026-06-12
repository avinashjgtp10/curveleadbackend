const { query } = require('../config/db');

const getAll = async (req, res) => {
  try {
    const { category, channel } = req.query;
    let where = 'WHERE tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;
    if (category) { where += ` AND category = $${i++}`; params.push(category); }
    if (channel)  { where += ` AND channel  = $${i++}`; params.push(channel); }

    const result = await query(
      `SELECT * FROM message_templates ${where} ORDER BY created_at DESC`,
      params
    );
    res.json({ templates: result.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const create = async (req, res) => {
  try {
    const { name, category = 'general', channel = 'whatsapp', message } = req.body;
    if (!name?.trim() || !message?.trim()) return res.status(400).json({ error: 'Name and message are required.' });

    const result = await query(
      `INSERT INTO message_templates (tenant_id, name, category, channel, message, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.tenantId, name.trim(), category, channel, message.trim(), req.user.id]
    );
    res.status(201).json({ template: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const update = async (req, res) => {
  try {
    const { name, category, channel, message } = req.body;
    const result = await query(
      `UPDATE message_templates
       SET name=COALESCE($1,name), category=COALESCE($2,category),
           channel=COALESCE($3,channel), message=COALESCE($4,message), updated_at=NOW()
       WHERE id=$5 AND tenant_id=$6 RETURNING *`,
      [name ?? null, category ?? null, channel ?? null, message ?? null, req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found.' });
    res.json({ template: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const remove = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM message_templates WHERE id=$1 AND tenant_id=$2 RETURNING id',
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Template not found.' });
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /templates/:id/send — generate message with lead variable substitution
const generate = async (req, res) => {
  try {
    const { lead_id } = req.body;

    const [tmplRes, leadRes] = await Promise.all([
      query('SELECT * FROM message_templates WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]),
      lead_id
        ? query('SELECT name, phone, email, location, source FROM leads WHERE id=$1 AND tenant_id=$2', [lead_id, req.tenantId])
        : Promise.resolve({ rows: [] }),
    ]);

    if (!tmplRes.rows.length) return res.status(404).json({ error: 'Template not found.' });

    const tmpl = tmplRes.rows[0];
    const lead = leadRes.rows[0] || {};

    const message = tmpl.message
      .replace(/\{\{name\}\}/gi, lead.name || '')
      .replace(/\{\{phone\}\}/gi, lead.phone || '')
      .replace(/\{\{email\}\}/gi, lead.email || '')
      .replace(/\{\{city\}\}/gi, lead.location || '')
      .replace(/\{\{source\}\}/gi, (lead.source || '').replace(/_/g, ' '));

    // Increment use count
    query('UPDATE message_templates SET use_count = use_count + 1 WHERE id=$1', [req.params.id]).catch(() => {});

    const phone = (lead.phone || '').replace(/\D/g, '').slice(-10);
    const whatsappUrl = phone
      ? `https://wa.me/91${phone}?text=${encodeURIComponent(message)}`
      : null;

    res.json({ message, whatsappUrl });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getAll, create, update, delete: remove, generate };
