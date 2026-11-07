const { query } = require('../config/db');
const { buildTimeline } = require('../utils/automationTimeline');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v) => parseInt(v, 10) || 0;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const clampDays = (v) => Math.min(Math.max(parseInt(v, 10) || 30, 1), 365);
// error_detail may not exist on older databases; reading it through to_jsonb keeps the query valid either way.
const DETAIL = `to_jsonb(m)->>'error_detail'`;

// GET /api/automations/leads/:leadId/timeline — everything automation did for one lead, in order.
const getLeadTimeline = async (req, res) => {
  try {
    const { leadId } = req.params;
    if (!UUID.test(leadId)) return res.status(422).json({ error: 'Invalid lead.' });
    const lead = (await query('SELECT id, name, assigned_to FROM leads WHERE id=$1 AND tenant_id=$2', [leadId, req.tenantId])).rows[0];
    if (!lead || (req.user.role === 'staff' && lead.assigned_to !== req.user.id)) return res.status(404).json({ error: 'Lead not found.' });
    const enrollments = (await query(
      `SELECT e.id, e.sequence_id, s.name AS sequence_name, r.name AS rule_name, r.trigger_type, e.status, e.current_step, e.enrolled_at, e.next_send_at,
              e.completed_at, e.cancelled_at, e.cancelled_reason, e.blocked_reason, e.last_error
       FROM automation_enrollments e JOIN automation_sequences s ON s.id=e.sequence_id LEFT JOIN automation_rules r ON r.id=e.rule_id
       WHERE e.tenant_id=$1 AND e.lead_id=$2 ORDER BY e.enrolled_at`, [req.tenantId, leadId])).rows;
    if (!enrollments.length) return res.json({ lead: { id: lead.id, name: lead.name }, events: [], current: [] });
    const ids = enrollments.map((e) => e.id);
    const [attempts, steps, replies] = await Promise.all([
      query(`SELECT a.enrollment_id, a.step_order, a.status, a.attempts, a.error, a.updated_at, m.status AS message_status, ${DETAIL} AS error_detail, m.template_name
             FROM automation_send_attempts a LEFT JOIN whatsapp_messages m ON m.tenant_id=a.tenant_id AND m.lead_id=$2 AND m.wa_message_id=a.wa_message_id
             WHERE a.tenant_id=$1 AND a.enrollment_id = ANY($3::uuid[])`, [req.tenantId, leadId, ids]),
      query(`SELECT sequence_id, channel FROM automation_sequence_steps WHERE tenant_id=$1 AND sequence_id = ANY($2::uuid[]) ORDER BY sequence_id, step_order`, [req.tenantId, [...new Set(enrollments.map((e) => e.sequence_id))]]),
      query(`SELECT enrollment_id, classification, outcome, created_at FROM automation_reply_events WHERE tenant_id=$1 AND lead_id=$2`, [req.tenantId, leadId]),
    ]);
    const bySeq = {};
    for (const s of steps.rows) (bySeq[s.sequence_id] ||= []).push({ channel: s.channel });
    res.json({ lead: { id: lead.id, name: lead.name }, ...buildTimeline({ enrollments, attempts: attempts.rows, steps: bySeq, replies: replies.rows }) });
  } catch (e) { console.error('getLeadTimeline:', e.message); res.status(500).json({ error: 'Could not load the timeline.' }); }
};

// GET /api/automations/sequences/:id/analytics?days=30 — how one sequence is doing.
const getSequenceAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(422).json({ error: 'Invalid sequence.' });
    const seq = (await query('SELECT id, name, is_active FROM automation_sequences WHERE id=$1 AND tenant_id=$2', [id, req.tenantId])).rows[0];
    if (!seq) return res.status(404).json({ error: 'Sequence not found.' });
    const days = clampDays(req.query.days);
    const p = [req.tenantId, id, String(days)];
    const scope = `e.tenant_id=$1 AND e.sequence_id=$2 AND e.enrolled_at >= NOW() - ($3 || ' days')::interval`;
    const [status, stops, funnel, failures, coverage, problems] = await Promise.all([
      query(`SELECT e.status, COUNT(*) AS c FROM automation_enrollments e WHERE ${scope} GROUP BY 1`, p),
      query(`SELECT COALESCE(e.cancelled_reason,'unknown') AS reason, COUNT(*) AS c FROM automation_enrollments e WHERE ${scope} AND e.status='cancelled' GROUP BY 1 ORDER BY c DESC`, p),
      query(`WITH st AS (SELECT channel, approved_template_name, row_number() OVER (ORDER BY step_order) - 1 AS idx FROM automation_sequence_steps WHERE tenant_id=$1 AND sequence_id=$2)
             SELECT st.idx, st.channel, st.approved_template_name,
               COUNT(a.id) FILTER (WHERE a.status='sent') AS sent,
               COUNT(a.id) FILTER (WHERE a.status='sent' AND m.status IN ('delivered','read')) AS delivered,
               COUNT(a.id) FILTER (WHERE a.status='sent' AND m.status='read') AS read,
               COUNT(a.id) FILTER (WHERE a.status IN ('failed','blocked','uncertain') OR m.status='failed') AS failed,
               COUNT(a.id) FILTER (WHERE a.status='sent' AND EXISTS (SELECT 1 FROM whatsapp_messages r WHERE r.tenant_id=e.tenant_id AND r.lead_id=e.lead_id AND r.direction='inbound'
                 AND r.sent_at > a.updated_at AND r.sent_at < a.updated_at + INTERVAL '3 days')) AS replied
             FROM st LEFT JOIN automation_send_attempts a ON a.tenant_id=$1 AND a.step_order=st.idx AND a.enrollment_id IN (SELECT e2.id FROM automation_enrollments e2 WHERE e2.tenant_id=$1 AND e2.sequence_id=$2 AND e2.enrolled_at >= NOW() - ($3 || ' days')::interval)
             LEFT JOIN automation_enrollments e ON e.id=a.enrollment_id
             LEFT JOIN whatsapp_messages m ON m.tenant_id=a.tenant_id AND m.wa_message_id=a.wa_message_id AND m.lead_id=e.lead_id
             GROUP BY st.idx, st.channel, st.approved_template_name ORDER BY st.idx`, p),
      query(`SELECT substring(d.detail from '^\\[(\\d+)\\]') AS code, MIN(d.detail) AS detail, COUNT(*) AS c FROM (
               SELECT COALESCE(${DETAIL}, a.error) AS detail FROM automation_send_attempts a JOIN automation_enrollments e ON e.id=a.enrollment_id
               LEFT JOIN whatsapp_messages m ON m.tenant_id=a.tenant_id AND m.wa_message_id=a.wa_message_id AND m.lead_id=e.lead_id
               WHERE ${scope} AND (a.status IN ('failed','blocked','uncertain') OR m.status='failed')) d GROUP BY 1 ORDER BY c DESC LIMIT 8`, p),
      query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE l.whatsapp_opt_in_at IS NOT NULL AND NOT COALESCE(l.opted_out,false)) AS opted_in,
                    COUNT(*) FILTER (WHERE COALESCE(l.opted_out,false)) AS opted_out,
                    COUNT(*) FILTER (WHERE e.blocked_reason='blocked_no_opt_in' OR e.cancelled_reason='blocked_no_opt_in') AS held_for_opt_in
             FROM automation_enrollments e JOIN leads l ON l.id=e.lead_id AND l.tenant_id=e.tenant_id WHERE ${scope}`, p),
      query(`SELECT e.id AS enrollment_id, e.lead_id, l.name AS lead_name, e.status, e.current_step, COALESCE(e.blocked_reason, e.last_error) AS reason
             FROM automation_enrollments e JOIN leads l ON l.id=e.lead_id AND l.tenant_id=e.tenant_id
             WHERE e.tenant_id=$1 AND e.sequence_id=$2 AND e.status IN ('blocked','failed','uncertain','human_review') ORDER BY e.enrolled_at DESC LIMIT 25`, [req.tenantId, id]),
    ]);
    const by = Object.fromEntries(status.rows.map((r) => [r.status, n(r.c)]));
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const c = coverage.rows[0];
    res.json({
      sequence: { id: seq.id, name: seq.name, is_active: seq.is_active }, days,
      enrolled: { total, by_status: by, completed: by.completed || 0, completion_rate: pct(by.completed || 0, total) },
      stopped_because: stops.rows.map((r) => ({ reason: r.reason, count: n(r.c) })),
      steps: funnel.rows.map((r) => ({ step_number: n(r.idx) + 1, channel: r.channel, template: r.approved_template_name || null, sent: n(r.sent), delivered: n(r.delivered), read: n(r.read), failed: n(r.failed), replied: n(r.replied), reply_rate: pct(n(r.replied), n(r.sent)) })),
      failure_reasons: failures.rows.map((r) => ({ code: r.code || null, detail: r.detail || null, count: n(r.c) })),
      opt_in: { total: n(c.total), opted_in: n(c.opted_in), opted_out: n(c.opted_out), held_for_opt_in: n(c.held_for_opt_in), coverage_rate: pct(n(c.opted_in), n(c.total)) },
      problems: problems.rows,
    });
  } catch (e) { console.error('getSequenceAnalytics:', e.message); res.status(500).json({ error: 'Could not load sequence analytics.' }); }
};

module.exports = { getLeadTimeline, getSequenceAnalytics };
