// Structured follow-up outcome logic — pure functions, no DB access, so they're
// unit-testable the same way utils/leadSla.js is (see tests/followupOutcome.test.js).
//
// Core principle: a call attempt and a follow-up task are different records.
// "No answer" means the rep completed an attempt — the follow-up process is not done.

const OUTCOMES = ['connected', 'no_answer', 'busy', 'unavailable', 'call_later', 'rescheduled', 'wrong_number', 'not_interested'];

const CONVERSATION_RESULTS = ['qualified', 'demo_booked', 'quotation_requested', 'won', 'not_interested', 'needs_followup'];

// scheduled/attempted/rescheduled/completed/cancelled are stored. "due"/"overdue" are
// derived at read time (see computeDisplayStatus) — a time-based state would go stale
// the moment it's written, same reasoning as the existing computeFollowupHealth util.
const FOLLOWUP_STATUSES = ['scheduled', 'attempted', 'rescheduled', 'completed', 'cancelled'];

const OUTCOME_LABELS = {
  connected: 'Connected',
  no_answer: 'No answer',
  busy: 'Busy',
  unavailable: 'Unavailable',
  call_later: 'Asked to call later',
  rescheduled: 'Rescheduled',
  wrong_number: 'Wrong number',
  not_interested: 'Not interested',
};

const CONVERSATION_RESULT_LABELS = {
  qualified: 'Qualified',
  demo_booked: 'Demo booked',
  quotation_requested: 'Quotation requested',
  won: 'Won',
  not_interested: 'Not interested',
  needs_followup: 'Needs another follow-up',
};

const LEAD_STATUS_BY_CONVERSATION_RESULT = {
  qualified: 'Qualified',
  demo_booked: 'Demo Booked',
  quotation_requested: 'Quotation Requested',
  won: 'Won',
  not_interested: 'Not Interested',
};

const requiresNextFollowup = (outcome, conversationResult) => {
  if (['no_answer', 'busy', 'unavailable', 'call_later', 'rescheduled'].includes(outcome)) return true;
  if (outcome === 'connected' && conversationResult === 'needs_followup') return true;
  return false;
};

const requiresConfirmation = (outcome, conversationResult) =>
  outcome === 'not_interested' || conversationResult === 'not_interested';

// Validates a "Log outcome" submission. Pure — takes already-parsed values, returns
// { valid, errors[] }. The controller is responsible for parsing the request body first.
const validateOutcomeInput = ({ outcome, conversationResult, nextFollowupAt, confirmed }) => {
  const errors = [];

  if (!OUTCOMES.includes(outcome)) {
    return { valid: false, errors: ['Invalid outcome.'] };
  }

  if (outcome === 'connected') {
    if (!conversationResult || !CONVERSATION_RESULTS.includes(conversationResult)) {
      errors.push('Conversation result is required when the outcome is Connected.');
    }
  } else if (conversationResult) {
    errors.push('Conversation result only applies when the outcome is Connected.');
  }

  const needsNextDate = requiresNextFollowup(outcome, conversationResult);
  if (needsNextDate) {
    if (!nextFollowupAt) {
      errors.push('A new follow-up date and time is required for this outcome.');
    } else if (Number.isNaN(new Date(nextFollowupAt).getTime())) {
      errors.push('The new follow-up date and time is not a valid date.');
    } else if (new Date(nextFollowupAt).getTime() <= Date.now()) {
      errors.push('The new follow-up date and time must be in the future.');
    }
  }

  const needsConfirmation = requiresConfirmation(outcome, conversationResult);
  if (needsConfirmation && !confirmed) {
    errors.push('Confirmation is required before marking this lead as Not Interested.');
  }

  return { valid: errors.length === 0, errors, needsNextDate, needsConfirmation };
};

const BASE_TRANSITION = { leadStatusUpdate: null, moveToWonStage: false, moveToLostStage: false };

// The core decision table. Given a validated outcome (+ conversation result for
// "connected"), decides what happens to the CURRENT follow-up record and the lead.
// Stage moves (won/lost) are expressed as intent here; the controller resolves the
// tenant's actual is_won/is_lost stage and falls back to leadStatusUpdate if none exists.
const computeOutcomeTransition = ({ outcome, conversationResult }) => {
  if (outcome === 'connected') {
    if (conversationResult === 'needs_followup') {
      return { ...BASE_TRANSITION, followupStatus: 'attempted', createsLinkedFollowup: true };
    }
    if (conversationResult === 'not_interested') {
      return { ...BASE_TRANSITION, followupStatus: 'completed', createsLinkedFollowup: false, leadStatusUpdate: 'Not Interested', moveToLostStage: true };
    }
    return {
      ...BASE_TRANSITION,
      followupStatus: 'completed',
      createsLinkedFollowup: false,
      leadStatusUpdate: LEAD_STATUS_BY_CONVERSATION_RESULT[conversationResult] || null,
      moveToWonStage: conversationResult === 'won',
    };
  }

  if (['no_answer', 'busy', 'unavailable'].includes(outcome)) {
    return { ...BASE_TRANSITION, followupStatus: 'attempted', createsLinkedFollowup: true };
  }

  if (['call_later', 'rescheduled'].includes(outcome)) {
    return { ...BASE_TRANSITION, followupStatus: 'rescheduled', createsLinkedFollowup: true };
  }

  if (outcome === 'wrong_number') {
    return { ...BASE_TRANSITION, followupStatus: 'attempted', createsLinkedFollowup: false, leadStatusUpdate: 'Wrong Number' };
  }

  if (outcome === 'not_interested') {
    return { ...BASE_TRANSITION, followupStatus: 'completed', createsLinkedFollowup: false, leadStatusUpdate: 'Not Interested', moveToLostStage: true };
  }

  throw new Error(`Unknown outcome: ${outcome}`);
};

// "Call attempted by Rahul — No answer. Next attempt scheduled for 13 July at 10:00 AM."
const buildActivityMessage = ({ outcome, conversationResult, attemptedByName, nextFollowupAt }) => {
  const outcomeLabel = outcome === 'connected'
    ? `Connected — ${CONVERSATION_RESULT_LABELS[conversationResult] || conversationResult}`
    : OUTCOME_LABELS[outcome];
  let msg = `Call attempted by ${attemptedByName} — ${outcomeLabel}.`;
  if (nextFollowupAt) {
    const when = new Date(nextFollowupAt).toLocaleString('en-IN', {
      day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    msg += ` Next attempt scheduled for ${when}.`;
  }
  return msg;
};

// due/overdue are derived, never stored — see FOLLOWUP_STATUSES comment above.
const computeDisplayStatus = (followup, now = Date.now()) => {
  if (!followup) return null;
  if (followup.status !== 'scheduled') return followup.status;
  if (!followup.next_followup_at) return 'scheduled';
  const due = new Date(followup.next_followup_at).getTime();
  if (due < now) return 'overdue';
  if (due - now <= 30 * 60 * 1000) return 'due';
  return 'scheduled';
};

module.exports = {
  OUTCOMES,
  CONVERSATION_RESULTS,
  FOLLOWUP_STATUSES,
  OUTCOME_LABELS,
  CONVERSATION_RESULT_LABELS,
  requiresNextFollowup,
  requiresConfirmation,
  validateOutcomeInput,
  computeOutcomeTransition,
  buildActivityMessage,
  computeDisplayStatus,
};
