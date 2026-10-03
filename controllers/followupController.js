const { query } = require('../config/db');
const followupSummary = require('../services/followupSummary');
const { transaction } = require('../config/db');
const { recordFirstResponse } = require('../utils/leadResponse');
const { getWorkspaceLocale, formatWhen } = require('../utils/workspaceLocale');

// GET /api/followups - Get all followups with pagination
const getFollowups = async (req, res) => {
  try {
    const { status, lead_id, type, page = 1, limit = 15 } = req.query;
    const offset = (page - 1) * limit;
    let where = 'WHERE f.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    if (req.user.role === 'staff') { where += ` AND l.assigned_to=$${i++}`; params.push(req.user.id); }
    if (status === 'stale') { where += ` AND ${followupSummary.overdue} AND f.next_followup_at < now()-interval '7 days'`; }
    else if (status === 'completed') {
      where += ' AND f.is_completed = true';
    } else if (status === 'overdue') {
      where += ` AND ${followupSummary.overdue}`;
    } else if (status === 'all') {
      // no filter — return all
    } else {
      where += ` AND ${followupSummary.active}`;
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
                l.assigned_to, lu.name as assigned_to_name, (${followupSummary.active}) AS actionable
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
    if ('next_followup_at' in req.body && !require('../utils/dateTime').validAppointmentDate(req.body.next_followup_at)) return res.status(422).json({ error: 'A valid appointment date with timezone is required.' });
    if (req.user.role === 'staff' && !(await query('SELECT 1 FROM lead_followups f JOIN leads l ON l.id=f.lead_id AND l.tenant_id=f.tenant_id WHERE f.id=$1 AND f.tenant_id=$2 AND l.assigned_to=$3',[req.params.id,req.tenantId,req.user.id])).rows.length) return res.status(404).json({error:'Followup not found.'});
    const allowedFields = ['notes', 'followup_type', 'next_followup_at', 'meeting_url'];
    const updates = [];
    const params = [req.params.id, req.tenantId];
    let i = 3;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${i++}`);
        params.push(field === 'next_followup_at' ? new Date(req.body[field]).toISOString() : req.body[field]);
      }
    }
    if (req.body.next_followup_at) updates.push('dismissed_at = NULL');
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
    if (req.user.role === 'staff' && !(await query('SELECT 1 FROM lead_followups f JOIN leads l ON l.id=f.lead_id AND l.tenant_id=f.tenant_id WHERE f.id=$1 AND f.tenant_id=$2 AND l.assigned_to=$3',[req.params.id,req.tenantId,req.user.id])).rows.length) return res.status(404).json({error:'Followup not found.'});
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
    if (req.user.role === 'staff' && !(await query('SELECT 1 FROM lead_followups f JOIN leads l ON l.id=f.lead_id AND l.tenant_id=f.tenant_id WHERE f.id=$1 AND f.tenant_id=$2 AND l.assigned_to=$3',[req.params.id,req.tenantId,req.user.id])).rows.length) return res.status(404).json({error:'Followup not found.'});
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
       `Was scheduled for ${formatWhen(f.next_followup_at, await getWorkspaceLocale(req.tenantId), { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' })}`,
       req.user.id]
    ).catch(() => {});

    res.json({ message: 'Deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

const getSummary = async (req,res) => {
 try { res.json(await followupSummary.summary(req.tenantId,req.user.role==='staff'?req.user.id:null)); }
 catch(e) { console.error('Follow-up summary:',e);res.status(500).json({error:'Could not load follow-ups.'}); }
};
const reviewFollowup = async (req,res) => {
 if (!['dismiss','lost'].includes(req.body.action)) return res.status(422).json({error:'Choose dismiss or lost.'});
 try {
  await transaction(async c => {
   const row=(await c.query(`SELECT f.*,l.stage FROM lead_followups f JOIN leads l ON l.id=f.lead_id AND l.tenant_id=f.tenant_id
    WHERE f.id=$1 AND f.tenant_id=$2 AND ($3::uuid IS NULL OR l.assigned_to=$3) FOR UPDATE OF f,l`,[req.params.id,req.tenantId,req.user.role==='staff'?req.user.id:null])).rows[0];
   if(!row) throw Object.assign(new Error('Follow-up not found.'),{status:404});
   if(req.body.action==='lost') {
    const stage=(await c.query('SELECT name FROM lead_stages WHERE tenant_id=$1 AND is_lost=true AND is_active=true ORDER BY pos LIMIT 1',[req.tenantId])).rows[0];
    if(!stage) throw Object.assign(new Error('Configure a Lost stage first.'),{status:422});
    await c.query('UPDATE leads SET stage=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3',[stage.name,row.lead_id,req.tenantId]);
    await c.query('UPDATE lead_followups SET dismissed_at=now() WHERE lead_id=$1 AND tenant_id=$2 AND is_completed=false',[row.lead_id,req.tenantId]);
   } else await c.query('UPDATE lead_followups SET dismissed_at=now() WHERE id=$1 AND tenant_id=$2',[row.id,req.tenantId]);
   await c.query(`INSERT INTO lead_activities(tenant_id,lead_id,activity_type,title,description,created_by)
    VALUES($1,$2,'followup_reviewed',$3,$4,$5)`,[req.tenantId,row.lead_id,req.body.action==='lost'?'Marked lost after follow-up review':'Follow-up dismissed','Overdue follow-up reviewed',req.user.id]);
  });
  res.json({message:'Follow-up reviewed.'});
 } catch(e) { console.error('Review follow-up:',e);res.status(e.status||500).json({error:e.status?e.message:'Could not review follow-up.'}); }
};
module.exports = { getSummary, reviewFollowup, getFollowups, updateFollowup, completeFollowup, deleteFollowup };
