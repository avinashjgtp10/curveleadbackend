const { query } = require('../config/db');

// GET /api/followups - Get all followups
const getFollowups = async (req, res) => {
  try {
    const { completed, lead_id, assigned_to, today, overdue } = req.query;
    let where = 'WHERE f.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    if (completed !== undefined) { where += ` AND f.completed = $${i++}`; params.push(completed === 'true'); }
    if (lead_id) { where += ` AND f.lead_id = $${i++}`; params.push(lead_id); }
    if (assigned_to) { where += ` AND f.assigned_to = $${i++}`; params.push(assigned_to); }
    if (today === 'true') where += ` AND DATE(f.scheduled_at) = CURRENT_DATE AND f.completed = false`;
    if (overdue === 'true') where += ` AND f.scheduled_at < NOW() AND f.completed = false`;

    const result = await query(
      `SELECT f.*, l.name as lead_name, l.phone as lead_phone, l.stage as lead_stage,
              u.name as assigned_to_name
       FROM followups f
       JOIN leads l ON f.lead_id = l.id
       LEFT JOIN users u ON f.assigned_to = u.id
       ${where} ORDER BY f.scheduled_at ASC`,
      params
    );

    res.json({ followups: result.rows });
  } catch (error) { console.error('Get followups error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/followups
const createFollowup = async (req, res) => {
  try {
    const { lead_id, title, description, type, scheduled_at, assigned_to } = req.body;
    if (!lead_id || !scheduled_at) return res.status(400).json({ error: 'lead_id and scheduled_at required.' });

    const result = await query(
      `INSERT INTO followups (tenant_id, lead_id, title, description, type, scheduled_at, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.tenantId, lead_id, title, description, type || 'call', scheduled_at, assigned_to, req.user.id]
    );

    res.status(201).json({ followup: result.rows[0] });
  } catch (error) { console.error('Create followup error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/followups/:id/complete
const completeFollowup = async (req, res) => {
  try {
    const { outcome } = req.body;
    const result = await query(
      `UPDATE followups SET completed = true, completed_at = NOW(), outcome = $1
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [outcome, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Followup not found.' });

    // Update lead's last_contacted
    await query('UPDATE leads SET last_contacted_at = NOW() WHERE id = $1', [result.rows[0].lead_id]);
    res.json({ followup: result.rows[0] });
  } catch (error) { console.error('Complete followup error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/followups/:id
const deleteFollowup = async (req, res) => {
  try {
    const result = await query('DELETE FROM followups WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Followup not found.' });
    res.json({ message: 'Deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getFollowups, createFollowup, completeFollowup, deleteFollowup };
