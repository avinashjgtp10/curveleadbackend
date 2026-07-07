// Deterministic Follow-up Health — pure date math over lead_followups, no AI involved.
// Keep thresholds in sync with frontend/src/utils/followupHealth.js.
const HOUR_MS = 60 * 60 * 1000;
const MISSED_AFTER_HOURS = 48;    // 2 days overdue
const CRITICAL_AFTER_HOURS = 120; // 5 days overdue

// pendingFollowup: the lead's current not-completed lead_followups row, or null/undefined.
function computeFollowupHealth(pendingFollowup) {
  if (!pendingFollowup || !pendingFollowup.next_followup_at) return 'good';
  const overdueHours = (Date.now() - new Date(pendingFollowup.next_followup_at).getTime()) / HOUR_MS;
  if (overdueHours <= 0) return 'good';
  if (overdueHours > CRITICAL_AFTER_HOURS) return 'critical';
  if (overdueHours > MISSED_AFTER_HOURS) return 'missed';
  return 'delayed';
}

module.exports = { computeFollowupHealth, MISSED_AFTER_HOURS, CRITICAL_AFTER_HOURS };
