const { query } = require('../config/db');

// GET /api/automations/enrollments?lead_ids=uuid1,uuid2,...
// One row per lead: its most recent ACTIVE enrollment, or (if none active)
// its most recent enrollment of any status — so history stays visible after
// a sequence finishes/gets cancelled. Leads with zero enrollments get no key;
// the frontend treats a missing key as "Not Enrolled".
const getEnrollments = async (req, res) => {
  try {
    const leadIds = (req.query.lead_ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!leadIds.length) return res.json({ enrollments: {} });

    const result = await query(
      `SELECT DISTINCT ON (e.lead_id)
              e.lead_id, e.id AS enrollment_id, e.sequence_id, e.current_step, e.status,
              e.enrolled_at, e.next_send_at, e.completed_at, e.cancelled_at,
              s.name AS sequence_name,
              COALESCE(json_agg(
                json_build_object('step_order', st.step_order, 'channel', st.channel, 'message', st.message)
                ORDER BY st.step_order
              ) FILTER (WHERE st.id IS NOT NULL), '[]') AS steps
       FROM automation_enrollments e
       JOIN automation_sequences s ON s.id = e.sequence_id
       LEFT JOIN automation_sequence_steps st ON st.sequence_id = e.sequence_id
       WHERE e.tenant_id = $1 AND e.lead_id = ANY($2::uuid[])
       GROUP BY e.id, s.name
       ORDER BY e.lead_id, (e.status = 'active') DESC, e.enrolled_at DESC`,
      [req.tenantId, leadIds]
    );

    const enrollments = {};
    for (const row of result.rows) enrollments[row.lead_id] = row;
    res.json({ enrollments });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getEnrollments };
