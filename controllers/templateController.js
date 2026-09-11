const { query } = require('../config/db');
const { substituteTemplateVars } = require('../utils/templateVars');

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
    const { name, category = 'general', channel = 'whatsapp', message, stage_name, campaign_id } = req.body;
    if (!name?.trim() || !message?.trim()) return res.status(400).json({ error: 'Name and message are required.' });

    const result = await query(
      `INSERT INTO message_templates (tenant_id, name, category, channel, message, created_by, stage_name, campaign_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.tenantId, name.trim(), category, channel, message.trim(), req.user.id, stage_name || null, campaign_id || null]
    );
    res.status(201).json({ template: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const update = async (req, res) => {
  try {
    const { name, category, channel, message, stage_name, campaign_id } = req.body;
    const result = await query(
      `UPDATE message_templates
       SET name=COALESCE($1,name), category=COALESCE($2,category),
           channel=COALESCE($3,channel), message=COALESCE($4,message),
           stage_name=COALESCE($5,stage_name), campaign_id=COALESCE($6,campaign_id), updated_at=NOW()
       WHERE id=$7 AND tenant_id=$8 RETURNING *`,
      [name ?? null, category ?? null, channel ?? null, message ?? null,
        stage_name ?? null, campaign_id ?? null, req.params.id, req.tenantId]
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

    const [tmplRes, leadRes, tenantRes] = await Promise.all([
      query('SELECT * FROM message_templates WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]),
      lead_id
        ? query(
            `SELECT l.name, l.phone, l.email, l.location, l.source,
                    c.name AS course_name, c.fee_amount, c.duration_value, c.duration_unit
             FROM leads l
             LEFT JOIN courses c ON c.id = l.course_interest_id
             WHERE l.id=$1 AND l.tenant_id=$2`,
            [lead_id, req.tenantId]
          )
        : Promise.resolve({ rows: [] }),
      query('SELECT name, phone FROM tenants WHERE id=$1', [req.tenantId]),
    ]);

    if (!tmplRes.rows.length) return res.status(404).json({ error: 'Template not found.' });

    const tmpl = tmplRes.rows[0];
    const lead = leadRes.rows[0] || {};
    const tenant = tenantRes.rows[0] || {};

    const message = substituteTemplateVars(tmpl.message, lead, tenant);

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
