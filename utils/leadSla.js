// Deterministic Lead Response SLA — pure date math, no AI involved.
// sla_status is a single mutually-exclusive, priority-ordered bucket (mirrors followupHealth.js).
const MINUTE_MS = 60 * 1000;
const TARGET_RESPONSE_MINUTES = 5;
const ESCALATION_AFTER_MINUTES = 15;
const REASSIGN_AFTER_MINUTES = 30;
const MISSED_AFTER_MINUTES = 24 * 60;
// Off by default — flip once a tenant-facing settings toggle exists (Phase 4).
const AUTO_REASSIGN_ENABLED = false;

// lead: { created_at, first_response_at }
function computeLeadSla({ created_at, first_response_at }) {
  if (first_response_at) {
    return { sla_status: 'contacted', is_uncontacted: false, is_escalated: false, elapsed_minutes: null, minutes_to_breach: null };
  }
  const elapsedMinutes = (Date.now() - new Date(created_at).getTime()) / MINUTE_MS;
  const sla_status =
    elapsedMinutes >= MISSED_AFTER_MINUTES ? 'missed_lead' :
    elapsedMinutes >= ESCALATION_AFTER_MINUTES ? 'sla_breached' :
    elapsedMinutes >= TARGET_RESPONSE_MINUTES ? 'sla_risk' : 'new';
  return {
    sla_status,
    is_uncontacted: true,
    is_escalated: elapsedMinutes >= ESCALATION_AFTER_MINUTES,
    elapsed_minutes: Math.floor(elapsedMinutes),
    minutes_to_breach: sla_status === 'new' ? Math.ceil(TARGET_RESPONSE_MINUTES - elapsedMinutes) : 0,
  };
}

module.exports = {
  computeLeadSla,
  TARGET_RESPONSE_MINUTES,
  ESCALATION_AFTER_MINUTES,
  REASSIGN_AFTER_MINUTES,
  MISSED_AFTER_MINUTES,
  AUTO_REASSIGN_ENABLED,
};
