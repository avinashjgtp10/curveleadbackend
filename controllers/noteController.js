const { query } = require('../config/db');

const getByLead = async (req, res) => {
  try {
    const result = await query(
      `SELECT n.*, u.name as created_by_name
       FROM lead_notes n
       LEFT JOIN users u ON n.created_by = u.id
       WHERE n.lead_id = $1 AND n.tenant_id = $2
       ORDER BY n.created_at DESC`,
      [req.params.leadId, req.tenantId]
    );
    res.json({ notes: result.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const create = async (req, res) => {
  try {
    const { note, note_type = 'general' } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: 'Note content is required.' });
    const result = await query(
      `INSERT INTO lead_notes (tenant_id, lead_id, note, note_type, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.tenantId, req.params.leadId, note.trim(), note_type, req.user.id]
    );
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,'note','Note Added',$3,$4)`,
      [req.tenantId, req.params.leadId, note.trim().substring(0, 100), req.user.id]
    );
    res.status(201).json({ note: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const update = async (req, res) => {
  try {
    const { note } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: 'Note content is required.' });
    const result = await query(
      `UPDATE lead_notes SET note=$1, updated_at=NOW()
       WHERE id=$2 AND lead_id=$3 AND tenant_id=$4 RETURNING *`,
      [note.trim(), req.params.noteId, req.params.leadId, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Note not found.' });
    res.json({ note: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const remove = async (req, res) => {
  try {
    await query(
      'DELETE FROM lead_notes WHERE id=$1 AND lead_id=$2 AND tenant_id=$3',
      [req.params.noteId, req.params.leadId, req.tenantId]
    );
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getByLead, create, update, delete: remove };
