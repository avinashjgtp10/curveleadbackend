const { query } = require('../config/db');
const { enrollLead } = require('../utils/automationTriggers');

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
       GROUP BY e.id, s.name, r.name, r.trigger_type
       ORDER BY e.lead_id, (e.status = 'active') DESC, e.enrolled_at DESC`,
      [req.tenantId, leadIds]
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
      `SELECT id FROM leads WHERE tenant_id = $1 AND id = ANY($2::uuid[])${isStaff ? ' AND assigned_to = $3' : ''}`,
      isStaff ? [req.tenantId, lead_ids, req.user.id] : [req.tenantId, lead_ids]
    );

    let enrolled = 0;
    for (const { id } of leads.rows) {
      if (await enrollLead({ tenantId: req.tenantId, leadId: id, sequenceId: sequence_id })) enrolled++;
    }
    res.json({ enrolled, skipped: lead_ids.length - enrolled });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getEnrollments, enrollBulk };
