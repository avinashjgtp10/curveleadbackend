const { query } = require('../config/db');

// GET /api/leads/:leadId/notes
const getNotes = async (req, res) => {
  try {
    const result = await query(
      `SELECT n.*, u.name as created_by_name
       FROM lead_notes n
       LEFT JOIN users u ON n.created_by = u.id
       WHERE n.tenant_id = $1 AND n.lead_id = $2
       ORDER BY n.created_at DESC`,
      [req.tenantId, req.params.leadId]
    );
    res.json({ notes: result.rows });
  } catch (error) {
    console.error('Get notes error:', error);
    res.status(500).json({ error: 'Failed to fetch notes.' });
  }
};

// POST /api/leads/:leadId/notes
const createNote = async (req, res) => {
  try {
    const { note, note_type = 'general' } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ error: 'Note content required.' });

    const result = await query(
      `INSERT INTO lead_notes (tenant_id, lead_id, note, note_type, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.tenantId, req.params.leadId, note.trim(), note_type, req.user.id]
    );

    // Activity log
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1, $2, 'note', 'Note added', $3, $4)`,
      [req.tenantId, req.params.leadId, note.substring(0, 100), req.user.id]
    );

    res.status(201).json({ note: result.rows[0] });
  } catch (error) {
    console.error('Create note error:', error);
    res.status(500).json({ error: 'Failed to create note.' });
  }
};

// PUT /api/leads/:leadId/notes/:noteId
const updateNote = async (req, res) => {
  try {
    const { note } = req.body;
    const result = await query(
      `UPDATE lead_notes
       SET note = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3 AND lead_id = $4
       RETURNING *`,
      [note, req.params.noteId, req.tenantId, req.params.leadId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Note not found.' });
    res.json({ note: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update note.' });
  }
};

// DELETE /api/leads/:leadId/notes/:noteId
const deleteNote = async (req, res) => {
  try {
    await query(
      `DELETE FROM lead_notes WHERE id = $1 AND tenant_id = $2 AND lead_id = $3`,
      [req.params.noteId, req.tenantId, req.params.leadId]
    );
    res.json({ message: 'Note deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete note.' });
  }
};

module.exports = { getNotes, createNote, updateNote, deleteNote };
