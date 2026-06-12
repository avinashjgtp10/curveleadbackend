const { query } = require('../config/db');
const path = require('path');
const fs = require('fs');

const getAll = async (req, res) => {
  try {
    const { category } = req.query;
    let where = 'WHERE tenant_id = $1';
    const params = [req.tenantId];
    if (category) { where += ` AND category = $${params.length + 1}`; params.push(category); }

    const result = await query(`SELECT * FROM brochures ${where} ORDER BY created_at DESC`, params);
    res.json({ brochures: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const upload = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { name, category = 'general' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const baseUrl = process.env.BACKEND_URL || `${proto}://${host}`;
    const fileUrl = `${baseUrl}/uploads/brochures/${req.file.filename}`;

    const result = await query(
      `INSERT INTO brochures (tenant_id, name, category, file_url, file_name, file_size, mime_type, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.tenantId, name, category, fileUrl, req.file.filename, req.file.size, req.file.mimetype, req.user.id]
    );
    res.status(201).json({ brochure: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const remove = async (req, res) => {
  try {
    const result = await query('DELETE FROM brochures WHERE id=$1 AND tenant_id=$2 RETURNING file_name', [req.params.id, req.tenantId]);
    if (result.rows.length && result.rows[0].file_name) {
      const filePath = path.join(__dirname, '../uploads/brochures', result.rows[0].file_name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const shareWithLead = async (req, res) => {
  try {
    const { brochureId, leadId } = req.params;

    const [brochureRes, leadRes, tenantRes] = await Promise.all([
      query('SELECT * FROM brochures WHERE id=$1 AND tenant_id=$2', [brochureId, req.tenantId]),
      query('SELECT name, phone FROM leads WHERE id=$1 AND tenant_id=$2', [leadId, req.tenantId]),
      query('SELECT name, phone FROM tenants WHERE id=$1', [req.tenantId]),
    ]);

    if (!brochureRes.rows.length) return res.status(404).json({ error: 'Brochure not found.' });
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead not found.' });

    const brochure = brochureRes.rows[0];
    const lead = leadRes.rows[0];
    const tenant = tenantRes.rows[0];

    // Log the share
    await query(
      'INSERT INTO brochure_shares (tenant_id, brochure_id, lead_id, shared_by) VALUES ($1,$2,$3,$4)',
      [req.tenantId, brochureId, leadId, req.user.id]
    );

    const msg = [
      `Hi ${lead.name}! 👋`,
      ``,
      `Here's our *${brochure.name}* for you:`,
      brochure.file_url,
      ``,
      tenant.phone ? `For more info, call us at ${tenant.phone}` : null,
      ``,
      `— ${tenant.name}`,
    ].filter(l => l !== null).join('\n');

    const phone = (lead.phone || '').replace(/\D/g, '').slice(-10);
    const whatsapp_url = phone ? `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}` : null;

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,'note','Brochure Shared',$3,$4)`,
      [req.tenantId, leadId, `Brochure "${brochure.name}" shared via WhatsApp`, req.user.id]
    );
    res.json({ whatsapp_url, message: msg });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getAll, upload, delete: remove, shareWithLead };
