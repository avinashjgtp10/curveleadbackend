const { query } = require('../config/db');
const { uploadToS3, deleteFromS3 } = require('../config/s3');
const { resolveWhatsAppCredentials } = require('../utils/whatsappCredentials');
const { sendTextMessage } = require('../services/whatsappService');
const { recordFirstResponse } = require('../utils/leadResponse');

const getAll = async (req, res) => {
  try {
    const { category } = req.query;
    let where = 'WHERE b.tenant_id = $1';
    const params = [req.tenantId];
    if (category) { where += ` AND b.category = $${params.length + 1}`; params.push(category); }

    const result = await query(
      `SELECT b.*, COUNT(bs.id)::int AS times_shared
       FROM brochures b
       LEFT JOIN brochure_shares bs ON bs.brochure_id = b.id
       ${where}
       GROUP BY b.id
       ORDER BY b.created_at DESC`,
      params
    );
    res.json({ brochures: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const upload = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { name, category = 'general' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required.' });

    const ext = req.file.originalname.split('.').pop();
    const key = `brochures/${req.tenantId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const fileUrl = await uploadToS3(req.file.buffer, key, req.file.mimetype);

    const result = await query(
      `INSERT INTO brochures (tenant_id, name, category, file_url, file_name, file_size, mime_type, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.tenantId, name, category, fileUrl, req.file.originalname, req.file.size, req.file.mimetype, req.user.id]
    );
    res.status(201).json({ brochure: result.rows[0] });
  } catch (e) { console.error('Brochure upload error:', e); res.status(500).json({ error: e.message || 'Failed.' }); }
};

const remove = async (req, res) => {
  try {
    const result = await query('DELETE FROM brochures WHERE id=$1 AND tenant_id=$2 RETURNING file_url', [req.params.id, req.tenantId]);
    if (result.rows.length) {
      await deleteFromS3(result.rows[0].file_url).catch(() => {});
    }
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const shareWithLead = async (req, res) => {
  try {
    const { brochureId, leadId } = req.params;

    const [brochureRes, leadRes, tenantRes] = await Promise.all([
      query('SELECT * FROM brochures WHERE id=$1 AND tenant_id=$2', [brochureId, req.tenantId]),
      query('SELECT name, phone, assigned_to FROM leads WHERE id=$1 AND tenant_id=$2', [leadId, req.tenantId]),
      query('SELECT name, phone FROM tenants WHERE id=$1', [req.tenantId]),
    ]);

    if (!brochureRes.rows.length) return res.status(404).json({ error: 'Brochure not found.' });
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead not found.' });

    const brochure = brochureRes.rows[0];
    const lead = leadRes.rows[0];
    const tenant = tenantRes.rows[0];
    if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number.' });

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

    const credentials = await resolveWhatsAppCredentials(req.tenantId, lead.assigned_to);
    const result = await sendTextMessage(lead.phone, msg, credentials);

    await query(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status, sent_by)
       VALUES ($1,$2,'outbound',$3,'text',$4,$5,$6)`,
      [req.tenantId, leadId, msg, result.wa_message_id || null, result.success ? 'sent' : 'failed', req.user.id]
    );

    // Log the share (non-fatal if table doesn't exist yet)
    query(
      'INSERT INTO brochure_shares (tenant_id, brochure_id, lead_id, shared_by) VALUES ($1,$2,$3,$4)',
      [req.tenantId, brochureId, leadId, req.user.id]
    ).catch(() => {});

    query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,'share_material','Material Shared',$3,$4)`,
      [req.tenantId, leadId, `Brochure "${brochure.name}" shared via WhatsApp`, req.user.id]
    ).catch(() => {});

    await query('UPDATE leads SET last_contacted_at = NOW(), ai_paused = true WHERE id = $1', [leadId]);
    recordFirstResponse(req.tenantId, leadId, { by: req.user.id, type: 'whatsapp' }).catch(() => {});

    res.json({ sent: result.success, dev: !!result.dev, message: msg, error: result.success ? undefined : result.error });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getAll, upload, delete: remove, shareWithLead };
