const { query } = require('../config/db');
const { enrollLead } = require('../utils/automationTriggers');

// GET /api/automations/enrollments?lead_ids=uuid1,uuid2,...
// One row per lead: its most recent ACTIVE enrollment, or (if none active)
// its most recent enrollment of any status — so history stays visible after
// a sequence finishes/gets cancelled. Leads with zero enrollments get no key;
// the frontend treats a missing key as "Not Enrolled".
const getEnrollments = async (req, res) => {
  try {
    const leadIds = req.method === 'POST' ? req.body?.lead_ids : (req.query.lead_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(leadIds) || leadIds.length > 500 || leadIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      return res.status(422).json({ error: 'lead_ids must contain at most 500 UUIDs.' });
    }
    if (!leadIds.length) return res.json({ enrollments: {} });

    const result = await query(
      `SELECT DISTINCT ON (e.lead_id)
              e.lead_id, e.id AS enrollment_id, e.sequence_id, e.current_step, e.status,
              e.enrolled_at, e.next_send_at, e.completed_at, e.cancelled_at, e.cancelled_reason,
              e.rule_id, r.name AS rule_name, r.trigger_type,
              s.name AS sequence_name,
              COALESCE(json_agg(
                json_build_object('step_order', st.step_order, 'channel', st.channel, 'message', st.message)
                ORDER BY st.step_order
              ) FILTER (WHERE st.id IS NOT NULL), '[]') AS steps
       FROM automation_enrollments e
       JOIN automation_sequences s ON s.id = e.sequence_id
       LEFT JOIN automation_rules r ON r.id = e.rule_id
       LEFT JOIN automation_sequence_steps st ON st.sequence_id = e.sequence_id
       WHERE e.tenant_id = $1 AND e.lead_id = ANY($2::uuid[])
         ${req.user.role === 'staff' ? 'AND EXISTS (SELECT 1 FROM leads l WHERE l.id = e.lead_id AND l.tenant_id = $1 AND l.assigned_to = $3)' : ''}
       GROUP BY e.id, s.name, r.name, r.trigger_type
       ORDER BY e.lead_id, (e.status = 'active') DESC, e.enrolled_at DESC`,
      req.user.role === 'staff' ? [req.tenantId, leadIds, req.user.id] : [req.tenantId, leadIds]
    );

    const enrollments = {};
    for (const row of result.rows) enrollments[row.lead_id] = row;
    res.json({ enrollments });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/automations/enroll-bulk { lead_ids, sequence_id }
// A lead can be enrolled in a given sequence only once ever, so leads that were
// already enrolled, opted out, or marked unresponsive are counted as skipped.
const enrollBulk = async (req, res) => {
  try {
    const { lead_ids, sequence_id } = req.body;
    if (!Array.isArray(lead_ids) || !lead_ids.length || !sequence_id) {
      return res.status(400).json({ error: 'lead_ids and sequence_id are required.' });
    }

    const seq = await query(
      'SELECT id, is_active FROM automation_sequences WHERE id = $1 AND tenant_id = $2',
      [sequence_id, req.tenantId]
    );
    if (!seq.rows.length) return res.status(404).json({ error: 'Sequence not found.' });
    if (!seq.rows[0].is_active) return res.status(400).json({ error: 'Sequence is inactive.' });

    const isStaff = req.user.role === 'staff';
    const leads = await query(
      `SELECT id FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL AND id = ANY($2::uuid[])${isStaff ? ' AND assigned_to = $3' : ''}`,
      isStaff ? [req.tenantId, lead_ids, req.user.id] : [req.tenantId, lead_ids]
    );

    let enrolled = 0;
    for (const { id } of leads.rows) {
      if (await enrollLead({ tenantId: req.tenantId, leadId: id, sequenceId: sequence_id })) enrolled++;
    }
    res.json({ enrolled, skipped: lead_ids.length - enrolled });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// Pagination, filters and statistics share the same tenant/staff scope.
const getAutomationLeads = async (req, res) => {
  try {
    const page = Number(req.query.page ?? 1), limit = Number(req.query.limit ?? 25);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(422).json({ error: 'Invalid pagination.' });
    const params = [req.tenantId];
    let scope = 'l.tenant_id = $1 AND l.merged_into_id IS NULL';
    if (req.user.role === 'staff') { params.push(req.user.id); scope += ' AND l.assigned_to = $2'; }
    const base = `WITH scoped AS (
      SELECT l.id, l.name, l.phone, l.won_at, l.lost_at, l.opted_out, e.enrollment,
        CASE WHEN l.won_at IS NOT NULL THEN 'Converted' WHEN l.lost_at IS NOT NULL THEN 'Lost'
        WHEN e.status = 'active' THEN 'In Progress' WHEN e.status = 'completed' THEN 'Completed'
        WHEN e.status = 'cancelled' THEN 'Cancelled' ELSE 'Not Enrolled' END AS status,
        CASE WHEN e.enrollment IS NULL THEN 'Not Enrolled' ELSE
          CASE WHEN e.status = 'cancelled' THEN 'Cancelled — ' ELSE '' END ||
          'Step ' || (e.current_step + 1) || ' of ' || e.step_count END AS step
      FROM leads l LEFT JOIN LATERAL (
        SELECT e.status, e.current_step, json_array_length(st.steps) AS step_count,
          to_jsonb(e) || jsonb_build_object('enrollment_id', e.id, 'sequence_name', s.name, 'steps', st.steps) AS enrollment
        FROM automation_enrollments e JOIN automation_sequences s ON s.id = e.sequence_id
        CROSS JOIN LATERAL (SELECT COALESCE(json_agg(json_build_object('step_order', step_order, 'channel', channel, 'message', message) ORDER BY step_order), '[]') AS steps FROM automation_sequence_steps WHERE sequence_id = e.sequence_id) st
        WHERE e.tenant_id = l.tenant_id AND e.lead_id = l.id
        ORDER BY (e.status = 'active') DESC, e.enrolled_at DESC, e.id DESC LIMIT 1
      ) e ON true WHERE ${scope}
    )`;
    let filter = 'true';
    for (const [key, sql] of [['search', '(name ILIKE $N OR phone ILIKE $N)'], ['status', 'status = $N'], ['step', 'step = $N']]) {
      if (req.query[key]) { params.push(key === 'search' ? `%${req.query[key]}%` : req.query[key]); filter += ' AND ' + sql.replaceAll('$N', '$' + params.length); }
    }
    const result = await query(`${base}, filtered AS (SELECT * FROM scoped WHERE ${filter})
      SELECT (SELECT COALESCE(json_agg(p), '[]') FROM (SELECT * FROM filtered ORDER BY name, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}) p) AS leads,
        (SELECT COUNT(*)::int FROM filtered) AS total,
        (SELECT json_build_object('total', COUNT(*), 'inProgress', COUNT(*) FILTER (WHERE status = 'In Progress'), 'converted', COUNT(*) FILTER (WHERE status = 'Converted'), 'lost', COUNT(*) FILTER (WHERE status = 'Lost')) FROM scoped) AS summary,
        (SELECT COALESCE(json_agg(step ORDER BY step), '[]') FROM (SELECT DISTINCT step FROM scoped) x) AS steps`, [...params, limit, (page - 1) * limit]);
    res.json({ ...result.rows[0], pagination: { page, limit, total: result.rows[0].total } });
  } catch (error) { console.error('getAutomationLeads:', error); res.status(500).json({ error: 'Unable to load automation leads.' }); }
};
module.exports = { getEnrollments, enrollBulk, getAutomationLeads };
