// Deterministic Lead Intent scoring — no AI/LLM involved.
// Replaces the old Groq-based scorer with rules over data the team already enters:
// follow-up health, lead_status text, rolled-over follow-ups, and contact recency.

const NEGATIVE_STATUS_KEYWORDS = [
  'not interested', 'no answer', 'no response', 'busy', 'switched off',
  'invalid', 'cancelled', 'canceled', 'lost', 'missed',
];
const POSITIVE_STATUS_KEYWORDS = [
  'interested', 'connected', 'scheduled', 'proposal', 'demo', 'visit completed',
  'price discussion', 'feature discussion', 'customer',
];

const matchesKeyword = (text, keywords) => {
  const lower = (text || '').toLowerCase();
  return keywords.some(k => lower.includes(k));
};

const FOLLOWUP_HEALTH_DELTA = { good: 10, delayed: -10, missed: -25, critical: -40 };

/**
 * @param {object} lead - has stage, lead_status, last_contacted_at, created_at
 * @param {string} followupHealth - good|delayed|missed|critical
 * @param {number} rolloverCount - recent lead_followups completed with no outcome recorded
 * @param {boolean} isWon - current stage is a "won" stage
 * @param {boolean} isLost - current stage is a "lost" stage
 */
function computeIntentScore({ lead, followupHealth, rolloverCount = 0, isWon = false, isLost = false }) {
  if (isWon) {
    return {
      intent_score: 100,
      score: 'hot',
      reason: 'Deal already won — no further intent scoring needed.',
      suggested_action: 'No action needed — deal closed.',
    };
  }
  if (isLost) {
    return {
      intent_score: 5,
      score: 'cold',
      reason: 'Lead is marked Lost.',
      suggested_action: 'Archive — no further action needed.',
    };
  }

  const reasons = [];
  let points = 50;

  points += FOLLOWUP_HEALTH_DELTA[followupHealth] ?? 0;
  const healthLabel = { good: 'on track', delayed: 'delayed', missed: 'missed', critical: 'critically overdue' }[followupHealth] || 'on track';
  reasons.push(`Follow-up is ${healthLabel}.`);

  const isNegativeStatus = matchesKeyword(lead.lead_status, NEGATIVE_STATUS_KEYWORDS);
  const isPositiveStatus = !isNegativeStatus && matchesKeyword(lead.lead_status, POSITIVE_STATUS_KEYWORDS);
  if (isNegativeStatus) {
    points -= 15;
    reasons.push(`Last status was "${lead.lead_status}".`);
  } else if (isPositiveStatus) {
    points += 15;
    reasons.push(`Last status was "${lead.lead_status}".`);
  }

  const rolloverPenalty = Math.min(rolloverCount, 3) * 8;
  if (rolloverPenalty > 0) {
    points -= rolloverPenalty;
    reasons.push(`${rolloverCount} recent follow-up${rolloverCount !== 1 ? 's were' : ' was'} rescheduled without a recorded outcome.`);
  }

  if (lead.last_contacted_at) {
    const daysSince = Math.floor((Date.now() - new Date(lead.last_contacted_at).getTime()) / 86400000);
    if (daysSince <= 3) { points += 10; reasons.push(`Contacted ${daysSince === 0 ? 'today' : `${daysSince} day(s) ago`}.`); }
    else if (daysSince > 14) { points -= 10; reasons.push(`No contact in ${daysSince} days.`); }
  } else {
    reasons.push('Never contacted yet.');
  }

  const intent_score = Math.max(0, Math.min(100, Math.round(points)));
  const score = intent_score >= 70 ? 'hot' : intent_score >= 40 ? 'warm' : 'cold';

  let suggested_action = 'Continue planned follow-up';
  if (followupHealth === 'critical') suggested_action = 'Manager follow-up needed';
  else if (isNegativeStatus) suggested_action = 'Call to confirm interest before marking Lost';
  else if (followupHealth === 'missed') suggested_action = 'Call and update status';
  else if (rolloverCount >= 2) suggested_action = "Get a real outcome on the next call — don't just reschedule";
  else if (followupHealth === 'delayed') suggested_action = 'Follow up today';
  else if (isPositiveStatus) suggested_action = 'Move forward — schedule the next step';

  return { intent_score, score, reason: reasons.join(' '), suggested_action };
}

module.exports = { computeIntentScore, NEGATIVE_STATUS_KEYWORDS, POSITIVE_STATUS_KEYWORDS };
