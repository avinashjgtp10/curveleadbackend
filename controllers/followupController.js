const { query } = require('../config/db');
const { recordFirstResponse } = require('../utils/leadResponse');

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

    // status='all' powers the per-lead history view — show pending items first (so the
    // one actionable row is always on page 1), then completed ones most-recent-first.
    // Every other status filter is already scoped to one is_completed value, where
    // soonest-due-first is the useful order.
    const orderBy = status === 'all'
      ? 'f.is_completed ASC, f.next_followup_at DESC'
      : 'f.next_followup_at ASC';

    const [result, countResult] = await Promise.all([
      query(
        `SELECT f.*, l.name as lead_name, l.phone as lead_phone, l.stage as lead_stage,
                lu.name as assigned_to_name
         FROM lead_followups f
         JOIN leads l ON f.lead_id = l.id
         LEFT JOIN users lu ON l.assigned_to = lu.id
         ${where} ORDER BY ${orderBy}
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

// PUT /api/followups/:id
const updateFollowup = async (req, res) => {
  try {
    const allowedFields = ['notes', 'followup_type', 'next_followup_at', 'meeting_url'];
    const updates = [];
    const params = [req.params.id, req.tenantId];
    let i = 3;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${i++}`);
        params.push(req.body[field]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    const result = await query(
      `UPDATE lead_followups SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Followup not found.' });

    res.json({ followup: result.rows[0] });
  } catch (error) { console.error('Update followup error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/followups/:id/complete
const completeFollowup = async (req, res) => {
  try {
    const { outcome } = req.body;
    const result = await query(
      `UPDATE lead_followups SET is_completed = true, outcome = $1, completed_at = NOW()
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [outcome, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Followup not found.' });

    const f = result.rows[0];
    const isDemo = f.followup_type === 'demo';

    await query('UPDATE leads SET last_contacted_at = NOW() WHERE id = $1', [f.lead_id]);
    recordFirstResponse(req.tenantId, f.lead_id, { by: req.user.id, type: 'followup_completed' }).catch(() => {});

    query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.tenantId, f.lead_id,
       isDemo ? 'demo_completed' : 'followup_completed',
       isDemo ? 'Demo Completed' : 'Follow-up Done',
       outcome ? `Outcome: ${outcome}` : (isDemo ? 'Demo marked as completed' : 'Follow-up marked as done'),
       req.user.id]
    ).catch(() => {});

    res.json({ followup: f });
  } catch (error) { console.error('Complete followup error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/followups/:id
const deleteFollowup = async (req, res) => {
  try {
    const existing = await query(
      'SELECT lead_id, followup_type, next_followup_at FROM lead_followups WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Followup not found.' });

    const f = existing.rows[0];
    const isDemo = f.followup_type === 'demo';

    await query('DELETE FROM lead_followups WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);

    query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.tenantId, f.lead_id,
       isDemo ? 'demo_cancelled' : 'followup_cancelled',
       isDemo ? 'Demo Cancelled' : 'Follow-up Cancelled',
       `Was scheduled for ${new Date(f.next_followup_at).toLocaleString('en-IN')}`,
       req.user.id]
    ).catch(() => {});

    res.json({ message: 'Deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getFollowups, updateFollowup, completeFollowup, deleteFollowup };
