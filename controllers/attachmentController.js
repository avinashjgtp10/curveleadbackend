const { query } = require('../config/db');
const { uploadToS3, deleteFromS3 } = require('../config/s3');

const getFileType = (mime) => {
  if (mime?.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime?.includes('word') || mime?.includes('document')) return 'doc';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('video/')) return 'video';
  return 'other';
};

const getByLead = async (req, res) => {
  try {
    const result = await query(
      `SELECT a.*, u.name as uploaded_by_name
       FROM lead_attachments a
       LEFT JOIN users u ON a.uploaded_by = u.id
       WHERE a.lead_id = $1 AND a.tenant_id = $2
       ORDER BY a.uploaded_at DESC`,
      [req.params.leadId, req.tenantId]
    );
    res.json({ attachments: result.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const upload = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { description = '' } = req.body;

    const safe = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const key = `attachments/${req.tenantId}/${req.params.leadId}/${Date.now()}-${safe}`;
    const fileUrl = await uploadToS3(req.file.buffer, key, req.file.mimetype);

    const result = await query(
      `INSERT INTO lead_attachments (tenant_id, lead_id, file_name, file_url, file_size, file_type, description, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.tenantId, req.params.leadId, req.file.originalname, fileUrl,
       req.file.size, getFileType(req.file.mimetype), description, req.user.id]
    );

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,'file_uploaded','File Uploaded',$3,$4)`,
      [req.tenantId, req.params.leadId, req.file.originalname, req.user.id]
    ).catch(() => {});

    res.status(201).json({ attachment: result.rows[0] });
  } catch (e) { console.error('Attachment upload error:', e); res.status(500).json({ error: 'Failed to upload file.' }); }
};

const remove = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM lead_attachments WHERE id=$1 AND lead_id=$2 AND tenant_id=$3 RETURNING file_url',
      [req.params.attachmentId, req.params.leadId, req.tenantId]
    );
    if (result.rows.length) {
      await deleteFromS3(result.rows[0].file_url).catch(() => {});
    }
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const shareWhatsApp = async (req, res) => {
  try {
    const [attRes, leadRes] = await Promise.all([
      query('SELECT * FROM lead_attachments WHERE id=$1 AND tenant_id=$2', [req.params.attachmentId, req.tenantId]),
      query('SELECT name, phone FROM leads WHERE id=$1 AND tenant_id=$2', [req.params.leadId, req.tenantId]),
    ]);
    if (!attRes.rows.length) return res.status(404).json({ error: 'File not found.' });
    const att = attRes.rows[0];
    const lead = leadRes.rows[0];
    const text = `Hi ${lead?.name || ''}! 👋\n\nHere is the file: *${att.file_name}*\n${att.file_url}`;
    const phone = (lead?.phone || '').replace(/\D/g, '').slice(-10);
    const whatsapp_url = phone
      ? `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    res.json({ whatsapp_url });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getByLead, upload, delete: remove, shareWhatsApp };
