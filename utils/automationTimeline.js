// Turns one lead's automation rows into a single ordered list of things that happened. Pure; no wording here
// (the screen words it, so failure reasons read the same everywhere). Never invents an event: every entry comes from a stored row.
const iso = (v) => (v ? new Date(v).toISOString() : null);

// enrollments: [{id, sequence_id, sequence_name, rule_name, trigger_type, status, enrolled_at, next_send_at, completed_at, cancelled_at, cancelled_reason, blocked_reason, last_error}]
// attempts:    [{enrollment_id, step_order, status, attempts, error, updated_at, message_status, error_detail, template_name}]
// steps:       { [sequence_id]: [{channel, ...}] } in step order
// replies:     [{enrollment_id, classification, outcome, created_at}]
const buildTimeline = ({ enrollments = [], attempts = [], steps = {}, replies = [] }) => {
  const events = [];
  const byId = new Map(enrollments.map((e) => [e.id, e]));
  const base = (e) => ({ enrollment_id: e.id, sequence_id: e.sequence_id, sequence_name: e.sequence_name });
  for (const e of enrollments) {
    events.push({ ...base(e), at: iso(e.enrolled_at), kind: 'enrolled', trigger: e.rule_name || null, trigger_type: e.trigger_type || null });
    if (e.status === 'completed' && e.completed_at) events.push({ ...base(e), at: iso(e.completed_at), kind: 'completed' });
    if (e.status === 'cancelled' && e.cancelled_at) events.push({ ...base(e), at: iso(e.cancelled_at), kind: 'stopped', reason: e.cancelled_reason || null });
  }
  for (const a of attempts) {
    const e = byId.get(a.enrollment_id); if (!e) continue;
    const step = (steps[e.sequence_id] || [])[a.step_order];
    const common = { ...base(e), at: iso(a.updated_at), step_number: a.step_order + 1, channel: step?.channel || null, template: a.template_name || null };
    if (a.status === 'sent') events.push({ ...common, kind: 'sent', delivery: a.message_status || null, error: a.message_status === 'failed' ? (a.error_detail || null) : null });
    else if (['failed', 'blocked', 'uncertain'].includes(a.status)) events.push({ ...common, kind: a.status, error: a.error || null });
    else if (a.status === 'retry') events.push({ ...common, kind: 'retrying', error: a.error || null, tries: a.attempts });
  }
  for (const r of replies) {
    const e = byId.get(r.enrollment_id);
    events.push({ ...(e ? base(e) : { enrollment_id: null, sequence_id: null, sequence_name: null }), at: iso(r.created_at), kind: 'reply', classification: r.classification || null, outcome: r.outcome || null });
  }
  events.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  // What is happening now for each unfinished enrollment (not a past event, so kept apart).
  const now = enrollments.filter((e) => !['completed', 'cancelled'].includes(e.status)).map((e) => ({
    ...base(e), status: e.status, next_step_number: (Number(e.current_step) || 0) + 1, next_send_at: iso(e.next_send_at),
    reason: e.blocked_reason || e.last_error || null,
  }));
  return { events, current: now };
};

module.exports = { buildTimeline };
