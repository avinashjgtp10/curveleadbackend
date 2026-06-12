const { query } = require('../config/db');
const path = require('path');
const fs = require('fs');

// Determine file type from mimetype
const getFileType = (mimetype) => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype === 'application/pdf') return 'pdf';
  if (mimetype.includes('word') || mimetype.includes('document')) return 'doc';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.includes('sheet') || mimetype.includes('excel')) return 'excel';
  return 'other';
};

// GET /api/leads/:leadId/attachments
const getAttachments = async (req, res) => {
  try {
    const result = await query(
      `SELECT a.*, u.name as uploaded_by_name
       FROM lead_attachments a
       LEFT JOIN users u ON a.uploaded_by = u.id
       WHERE a.tenant_id = $1 AND a.lead_id = $2
       ORDER BY a.uploaded_at DESC`,
      [req.tenantId, req.params.leadId]
    );
    res.json({ attachments: result.rows });
  } catch (error) {
    console.error('Get attachments error:', error);
    res.status(500).json({ error: 'Failed to fetch attachments.' });
  }
};

// POST /api/leads/:leadId/attachments (with multer middleware)
const uploadAttachment = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const { description } = req.body;
    const fileUrl = `/uploads/leads/${req.params.leadId}/${req.file.filename}`;
    const fileType = getFileType(req.file.mimetype);

    const result = await query(
      `INSERT INTO lead_attachments (tenant_id, lead_id, file_name, file_url, file_type, file_size, description, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.tenantId, req.params.leadId, req.file.originalname, fileUrl, fileType, req.file.size, description || null, req.user.id]
    );

    // Activity log
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1, $2, 'file_upload', $3, $4, $5)`,
      [req.tenantId, req.params.leadId, `File uploaded: ${req.file.originalname}`, description, req.user.id]
    );

    res.status(201).json({ attachment: result.rows[0] });
  } catch (error) {
    console.error('Upload attachment error:', error);
    res.status(500).json({ error: 'Failed to upload file.' });
  }
};

// DELETE /api/leads/:leadId/attachments/:attachmentId
const deleteAttachment = async (req, res) => {
  try {
    const result = await query(
      `SELECT file_url FROM lead_attachments WHERE id = $1 AND tenant_id = $2`,
      [req.params.attachmentId, req.tenantId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Attachment not found.' });

    // Delete file from disk
    const filePath = path.join(__dirname, '..', 'public', result.rows[0].file_url);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await query(`DELETE FROM lead_attachments WHERE id = $1 AND tenant_id = $2`, [req.params.attachmentId, req.tenantId]);

    res.json({ message: 'Attachment deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete attachment.' });
  }
};

// POST /api/leads/:leadId/attachments/:attachmentId/share-whatsapp
const shareAttachmentOnWhatsApp = async (req, res) => {
  try {
    const fileResult = await query(
      `SELECT * FROM lead_attachments WHERE id = $1 AND tenant_id = $2`,
      [req.params.attachmentId, req.tenantId]
    );
    if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found.' });

    const leadResult = await query(
      `SELECT phone, name FROM leads WHERE id = $1 AND tenant_id = $2`,
      [req.params.leadId, req.tenantId]
    );
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const file = fileResult.rows[0];
    const lead = leadResult.rows[0];
    const fullUrl = `${process.env.FRONTEND_URL || ''}${file.file_url}`;

    // Save as WhatsApp message
    const msgResult = await query(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, media_url, sent_by)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6)
       RETURNING *`,
      [req.tenantId, req.params.leadId, `Shared: ${file.file_name}`, file.file_type, fullUrl, req.user.id]
    );

    // WhatsApp click-to-chat URL (lead can be opened by user)
    const waLink = `https://wa.me/${lead.phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(`Hi ${lead.name}, please find the document: ${fullUrl}`)}`;

    res.json({ message: 'File ready to share.', whatsapp_url: waLink, msg: msgResult.rows[0] });
  } catch (error) {
    console.error('Share file error:', error);
    res.status(500).json({ error: 'Failed to share file.' });
  }
};

module.exports = { getAttachments, uploadAttachment, deleteAttachment, shareAttachmentOnWhatsApp };
