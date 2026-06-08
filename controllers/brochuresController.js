const { query } = require('../config/db');
const path = require('path');
const fs = require('fs');

// GET /api/brochures
const getBrochures = async (req, res) => {
  try {
    const { category } = req.query;
    let sql = `SELECT b.*, u.name as created_by_name FROM brochures b
               LEFT JOIN users u ON b.created_by = u.id
               WHERE b.tenant_id = $1 AND b.is_active = true`;
    const params = [req.tenantId];

    if (category) { sql += ` AND b.category = $2`; params.push(category); }
    sql += ` ORDER BY b.created_at DESC`;

    const result = await query(sql, params);
    res.json({ brochures: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch brochures.' });
  }
};

// POST /api/brochures (with multer)
const uploadBrochure = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const { name, description, category = 'general' } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required.' });

    const fileUrl = `/uploads/brochures/${req.file.filename}`;
    const fileType = req.file.mimetype === 'application/pdf' ? 'pdf' :
                     req.file.mimetype.startsWith('image/') ? 'image' : 'other';

    const result = await query(
      `INSERT INTO brochures (tenant_id, name, description, file_url, file_type, file_size, category, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.tenantId, name, description || null, fileUrl, fileType, req.file.size, category, req.user.id]
    );

    res.status(201).json({ brochure: result.rows[0] });
  } catch (error) {
    console.error('Upload brochure error:', error);
    res.status(500).json({ error: 'Failed to upload brochure.' });
  }
};

// DELETE /api/brochures/:id
const deleteBrochure = async (req, res) => {
  try {
    const result = await query(
      `SELECT file_url FROM brochures WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });

    // Soft delete (in case multiple leads have it shared)
    await query(`UPDATE brochures SET is_active = false WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]);

    res.json({ message: 'Brochure deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete.' });
  }
};

// POST /api/brochures/:id/share/:leadId
const shareBrochureWithLead = async (req, res) => {
  try {
    const brochureResult = await query(
      `SELECT * FROM brochures WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (brochureResult.rows.length === 0) return res.status(404).json({ error: 'Brochure not found.' });

    const leadResult = await query(
      `SELECT phone, name FROM leads WHERE id = $1 AND tenant_id = $2`,
      [req.params.leadId, req.tenantId]
    );
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const brochure = brochureResult.rows[0];
    const lead = leadResult.rows[0];
    const fullUrl = `${process.env.FRONTEND_URL || ''}${brochure.file_url}`;

    // Track share count
    await query(`UPDATE brochures SET times_shared = times_shared + 1 WHERE id = $1`, [req.params.id]);

    // Save as WhatsApp message
    await query(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, media_url, sent_by)
       VALUES ($1, $2, 'outbound', $3, 'document', $4, $5)`,
      [req.tenantId, req.params.leadId, `Shared brochure: ${brochure.name}`, fullUrl, req.user.id]
    );

    // Activity log
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
       VALUES ($1, $2, 'brochure_shared', $3, $4)`,
      [req.tenantId, req.params.leadId, `Brochure shared: ${brochure.name}`, req.user.id]
    );

    // WhatsApp click-to-chat URL
    const message = `Hi ${lead.name},\n\nHere's our ${brochure.name}:\n${fullUrl}\n\nLet me know if you have any questions!`;
    const waLink = `https://wa.me/${lead.phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(message)}`;

    res.json({ message: 'Brochure ready to share.', whatsapp_url: waLink, file_url: fullUrl });
  } catch (error) {
    console.error('Share brochure error:', error);
    res.status(500).json({ error: 'Failed to share brochure.' });
  }
};

module.exports = { getBrochures, uploadBrochure, deleteBrochure, shareBrochureWithLead };
