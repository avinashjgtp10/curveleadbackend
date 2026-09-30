const { query, transaction } = require('../config/db');

// GET /api/automations/assignment-rules
const getAssignmentRules = async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, u.name AS assign_to_user_name, t.name AS assign_to_team_name, s.name AS sequence_name
       FROM assignment_rules r
       LEFT JOIN users u ON u.id = r.assign_to_user_id
       LEFT JOIN teams t ON t.id = r.assign_to_team_id
       LEFT JOIN automation_sequences s ON s.id = r.sequence_id
       WHERE r.tenant_id = $1
       ORDER BY r.priority ASC, r.created_at ASC`,
      [req.tenantId]
    );
    res.json({ rules: result.rows });
  } catch (e) { console.error(e); res.status(e.status||500).json({ error: e.status?e.message:'Failed.' }); }
};

const validateTarget = (body) => {
  if (Array.isArray(body.staff_ids) && body.staff_ids.length) return body.assign_to_user_id || body.assign_to_team_id ? 'Choose only one assignment target.' : null;
  const { assign_to_user_id, assign_to_team_id } = body;
  if (!assign_to_user_id && !assign_to_team_id) return 'assign_to_user_id or assign_to_team_id is required.';
  if (assign_to_user_id && assign_to_team_id) return 'Set only one of assign_to_user_id or assign_to_team_id.';
  return null;
};

// POST /api/automations/assignment-rules
const createAssignmentRule = async (req, res) => {
  try {
    const { name, sources, campaign_ids, location_contains, assign_to_user_id, assign_to_team_id, sequence_id, staff_ids } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' });
    const targetError = validateTarget(req.body);
    if (targetError) return res.status(400).json({ error: targetError });


    const refs = [['users',req.body.staff_ids || []], ['users',[req.body.assign_to_user_id].filter(Boolean)], ['teams',[req.body.assign_to_team_id].filter(Boolean)], ['campaigns',req.body.campaign_ids || []], ['automation_sequences',[req.body.sequence_id].filter(Boolean)]];
    for (const [table,ids] of refs) {
      if (!Array.isArray(ids) || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) return res.status(422).json({error:'Invalid assignment reference.'});
      if (ids.length && (await query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,[req.tenantId,ids])).rows.length !== new Set(ids).size) return res.status(422).json({error:'Assignment references must belong to this workspace.'});
    }
    const maxPos = await query('SELECT COALESCE(MAX(priority), -1) + 1 AS next FROM assignment_rules WHERE tenant_id = $1', [req.tenantId]);

    const result = await query(
      `INSERT INTO assignment_rules
         (tenant_id, name, priority, sources, campaign_ids, location_contains, assign_to_user_id, assign_to_team_id, sequence_id, staff_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.tenantId, name.trim(), maxPos.rows[0].next,
        sources?.length ? sources : null,
        campaign_ids?.length ? campaign_ids : null,
        location_contains?.trim() || null,
        assign_to_user_id || null, assign_to_team_id || null, sequence_id || null, staff_ids || [],
      ]
    );
    res.status(201).json({ rule: result.rows[0] });
  } catch (e) { console.error(e); res.status(e.status||500).json({ error: e.status?e.message:'Failed.' }); }
};

// PUT /api/automations/assignment-rules/:id
const updateAssignmentRule = async (req, res) => {
  try {
    const owned = await query('SELECT id FROM assignment_rules WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Rule not found.' });

    const { assign_to_user_id, assign_to_team_id } = req.body;
    if (assign_to_user_id !== undefined && assign_to_team_id !== undefined && assign_to_user_id && assign_to_team_id) {
      return res.status(400).json({ error: 'Set only one of assign_to_user_id or assign_to_team_id.' });
    }


    const refs = [['users',req.body.staff_ids || []], ['users',[req.body.assign_to_user_id].filter(Boolean)], ['teams',[req.body.assign_to_team_id].filter(Boolean)], ['campaigns',req.body.campaign_ids || []], ['automation_sequences',[req.body.sequence_id].filter(Boolean)]];
    for (const [table,ids] of refs) {
      if (!Array.isArray(ids) || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) return res.status(422).json({error:'Invalid assignment reference.'});
      if (ids.length && (await query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,[req.tenantId,ids])).rows.length !== new Set(ids).size) return res.status(422).json({error:'Assignment references must belong to this workspace.'});
    }
    const sets = [];
    const params = [];
    let i = 1;
    const set = (column, value) => { sets.push(`${column} = $${i++}`); params.push(value); };

    if (req.body.staff_ids !== undefined) { set('staff_ids', req.body.staff_ids); set('assign_to_user_id', null); set('assign_to_team_id', null); }
    if (req.body.name !== undefined && (typeof req.body.name!=='string'||!req.body.name.trim()))return res.status(422).json({error:'Name is required.'});
    if (req.body.name !== undefined) set('name', req.body.name.trim());
    if (req.body.sources !== undefined) set('sources', req.body.sources?.length ? req.body.sources : null);
    if (req.body.campaign_ids !== undefined) set('campaign_ids', req.body.campaign_ids?.length ? req.body.campaign_ids : null);
    if (req.body.location_contains !== undefined) set('location_contains', req.body.location_contains?.trim() || null);
    if (req.body.sequence_id !== undefined) set('sequence_id', req.body.sequence_id || null);
    if (req.body.is_active !== undefined) set('is_active', req.body.is_active);
    // Assignment target is exclusive — picking one clears the other.
    if (req.body.staff_ids !== undefined) {}
    else if (assign_to_user_id !== undefined) { set('staff_ids', []); set('assign_to_user_id', assign_to_user_id || null); set('assign_to_team_id', null); }
    else if (assign_to_team_id !== undefined) { set('staff_ids', []); set('assign_to_team_id', assign_to_team_id || null); set('assign_to_user_id', null); }

    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
    sets.push('updated_at = NOW()');
    params.push(req.params.id, req.tenantId);

    const result = await query(
      `UPDATE assignment_rules SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
      params
    );
    res.json({ rule: result.rows[0] });
  } catch (e) { console.error(e); res.status(e.status||500).json({ error: e.status?e.message:'Failed.' }); }
};

// DELETE /api/automations/assignment-rules/:id
const deleteAssignmentRule = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM assignment_rules WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ message: 'Deleted.' });
  } catch (e) { console.error(e); res.status(e.status||500).json({ error: e.status?e.message:'Failed.' }); }
};

// PUT /api/automations/assignment-rules/reorder - body: { ids: [uuid, ...] } in desired priority order
const reorderAssignmentRules = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array is required.' });

    if(new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)))return res.status(422).json({error:'Invalid rule order.'});
    await transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`assignment:${req.tenantId}`]);
      const owned=(await client.query('SELECT id FROM assignment_rules WHERE tenant_id=$1',[req.tenantId])).rows;
      if(owned.length!==ids.length||owned.some(r=>!ids.includes(r.id)))throw Object.assign(new Error('Order must contain every workspace rule once.'),{status:422});
      for(let i=0;i<ids.length;i++)await client.query('UPDATE assignment_rules SET priority=$1 WHERE id=$2 AND tenant_id=$3',[i,ids[i],req.tenantId]);
    });
    res.json({ message: 'Reordered.' });
  } catch (e) { console.error(e); res.status(e.status||500).json({ error: e.status?e.message:'Failed.' }); }
};

module.exports = {
  getAssignmentRules, createAssignmentRule, updateAssignmentRule, deleteAssignmentRule, reorderAssignmentRules,
};
