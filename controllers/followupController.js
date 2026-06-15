const { query } = require('../config/db');

// GET /api/followups - Get all followups with pagination
const getFollowups = async (req, res) => {
  try {
    const { status, lead_id, type, page = 1, limit = 15 } = req.query;
    const offset = (page - 1) * limit;
    let where = 'WHERE f.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    if (status === 'completed') {
      where += ' AND f.is_completed = true';
    } else if (status === 'overdue') {
      where += ' AND f.is_completed = false AND f.next_followup_at < NOW()';
    } else if (status === 'all') {
      // no filter — return all
    } else {
      where += ' AND f.is_completed = false';
    }

    if (lead_id) { where += ` AND f.lead_id = $${i++}`; params.push(lead_id); }
    if (type)    { where += ` AND f.followup_type = $${i++}`; params.push(type); }

    const [result, countResult] = await Promise.all([
      query(
        `SELECT f.*, l.name as lead_name, l.phone as lead_phone, l.stage as lead_stage,
                lu.name as assigned_to_name
         FROM lead_followups f
         JOIN leads l ON f.lead_id = l.id
         LEFT JOIN users lu ON l.assigned_to = lu.id
         ${where} ORDER BY f.next_followup_at ASC
         LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) FROM lead_followups f JOIN leads l ON f.lead_id = l.id ${where}`, params),
    ]);

    const total = parseInt(countResult.rows[0].count);
    res.json({
      followups: result.rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) },
    });
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
      `UPDATE lead_followups SET is_completed = true, outcome = $1
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [outcome, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Followup not found.' });

    await query('UPDATE leads SET last_contacted_at = NOW() WHERE id = $1', [result.rows[0].lead_id]);
    res.json({ followup: result.rows[0] });
  } catch (error) { console.error('Complete followup error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/followups/:id
const deleteFollowup = async (req, res) => {
  try {
    const result = await query('DELETE FROM lead_followups WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Followup not found.' });
    res.json({ message: 'Deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getFollowups, createFollowup, completeFollowup, deleteFollowup };
