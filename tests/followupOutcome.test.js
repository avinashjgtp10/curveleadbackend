const assert = require('assert');
const {
  validateOutcomeInput,
  computeOutcomeTransition,
  buildActivityMessage,
  computeDisplayStatus,
  requiresNextFollowup,
  requiresConfirmation,
} = require('../utils/followupOutcome');

function run(name, fn) {
  fn();
  console.log(`ok - ${name}`);
}

const inFuture = (mins = 60) => new Date(Date.now() + mins * 60000).toISOString();
const inPast = (mins = 60) => new Date(Date.now() - mins * 60000).toISOString();

// ── Connected ────────────────────────────────────────────────────────────

run('connected + qualified -> completed, no linked followup, lead status Qualified', () => {
  const v = validateOutcomeInput({ outcome: 'connected', conversationResult: 'qualified' });
  assert.strictEqual(v.valid, true);
  const t = computeOutcomeTransition({ outcome: 'connected', conversationResult: 'qualified' });
  assert.strictEqual(t.followupStatus, 'completed');
  assert.strictEqual(t.createsLinkedFollowup, false);
  assert.strictEqual(t.leadStatusUpdate, 'Qualified');
  assert.strictEqual(t.moveToWonStage, false);
});

run('connected + won -> completed and moves to won stage', () => {
  const t = computeOutcomeTransition({ outcome: 'connected', conversationResult: 'won' });
  assert.strictEqual(t.followupStatus, 'completed');
  assert.strictEqual(t.moveToWonStage, true);
  assert.strictEqual(t.leadStatusUpdate, 'Won');
});

run('connected without a conversation result is invalid', () => {
  const v = validateOutcomeInput({ outcome: 'connected' });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /conversation result/i.test(e)));
});

run('connected + needs_followup requires a future next date, creates a linked followup', () => {
  assert.strictEqual(requiresNextFollowup('connected', 'needs_followup'), true);
  const missing = validateOutcomeInput({ outcome: 'connected', conversationResult: 'needs_followup' });
  assert.strictEqual(missing.valid, false);
  const withDate = validateOutcomeInput({ outcome: 'connected', conversationResult: 'needs_followup', nextFollowupAt: inFuture() });
  assert.strictEqual(withDate.valid, true);
  const t = computeOutcomeTransition({ outcome: 'connected', conversationResult: 'needs_followup' });
  assert.strictEqual(t.followupStatus, 'attempted');
  assert.strictEqual(t.createsLinkedFollowup, true);
});

// ── No answer / Busy / Unavailable ──────────────────────────────────────

['no_answer', 'busy', 'unavailable'].forEach(outcome => {
  run(`${outcome} -> attempted (not completed), requires next attempt date, creates linked followup`, () => {
    assert.strictEqual(requiresNextFollowup(outcome), true);
    const t = computeOutcomeTransition({ outcome });
    assert.strictEqual(t.followupStatus, 'attempted');
    assert.notStrictEqual(t.followupStatus, 'completed');
    assert.strictEqual(t.createsLinkedFollowup, true);
    assert.strictEqual(t.leadStatusUpdate, null);
  });
});

run('no_answer without a next date is invalid (the journey must not silently close)', () => {
  const v = validateOutcomeInput({ outcome: 'no_answer' });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /follow-up date/i.test(e)));
});

// ── Call later / Reschedule ─────────────────────────────────────────────

['call_later', 'rescheduled'].forEach(outcome => {
  run(`${outcome} -> status "rescheduled", requires next date, creates linked followup`, () => {
    const t = computeOutcomeTransition({ outcome });
    assert.strictEqual(t.followupStatus, 'rescheduled');
    assert.strictEqual(t.createsLinkedFollowup, true);
    const v = validateOutcomeInput({ outcome });
    assert.strictEqual(v.valid, false); // missing date
  });
});

// ── Wrong number ─────────────────────────────────────────────────────────

run('wrong_number -> attempted, flags lead status, no linked followup, no date required', () => {
  assert.strictEqual(requiresNextFollowup('wrong_number'), false);
  const t = computeOutcomeTransition({ outcome: 'wrong_number' });
  assert.strictEqual(t.followupStatus, 'attempted');
  assert.strictEqual(t.createsLinkedFollowup, false);
  assert.strictEqual(t.leadStatusUpdate, 'Wrong Number');
  const v = validateOutcomeInput({ outcome: 'wrong_number' });
  assert.strictEqual(v.valid, true); // no date needed, no confirmation needed
});

// ── Not interested ───────────────────────────────────────────────────────

run('not_interested requires confirmation before it validates', () => {
  assert.strictEqual(requiresConfirmation('not_interested'), true);
  const unconfirmed = validateOutcomeInput({ outcome: 'not_interested' });
  assert.strictEqual(unconfirmed.valid, false);
  assert.ok(unconfirmed.errors.some(e => /confirmation/i.test(e)));
  const confirmed = validateOutcomeInput({ outcome: 'not_interested', confirmed: true });
  assert.strictEqual(confirmed.valid, true);
});

run('not_interested -> completed, no linked followup, flags lost stage + lead status', () => {
  const t = computeOutcomeTransition({ outcome: 'not_interested' });
  assert.strictEqual(t.followupStatus, 'completed');
  assert.strictEqual(t.createsLinkedFollowup, false);
  assert.strictEqual(t.leadStatusUpdate, 'Not Interested');
  assert.strictEqual(t.moveToLostStage, true);
});

run('connected + not_interested also requires confirmation and flags lost stage', () => {
  assert.strictEqual(requiresConfirmation('connected', 'not_interested'), true);
  const v = validateOutcomeInput({ outcome: 'connected', conversationResult: 'not_interested' });
  assert.strictEqual(v.valid, false);
  const t = computeOutcomeTransition({ outcome: 'connected', conversationResult: 'not_interested' });
  assert.strictEqual(t.moveToLostStage, true);
  assert.strictEqual(t.followupStatus, 'completed');
});

// ── Date validation ──────────────────────────────────────────────────────

run('a next follow-up date in the past is rejected', () => {
  const v = validateOutcomeInput({ outcome: 'no_answer', nextFollowupAt: inPast() });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /future/i.test(e)));
});

run('an invalid date string is rejected', () => {
  const v = validateOutcomeInput({ outcome: 'no_answer', nextFollowupAt: 'not-a-date' });
  assert.strictEqual(v.valid, false);
});

run('a conversation result on a non-connected outcome is rejected', () => {
  const v = validateOutcomeInput({ outcome: 'busy', conversationResult: 'qualified', nextFollowupAt: inFuture() });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /only applies when the outcome is Connected/i.test(e)));
});

run('an unknown outcome is rejected', () => {
  const v = validateOutcomeInput({ outcome: 'shouted_and_hung_up' });
  assert.strictEqual(v.valid, false);
});

// ── Activity timeline message ───────────────────────────────────────────

run('activity message matches the spec example format', () => {
  const msg = buildActivityMessage({
    outcome: 'no_answer',
    attemptedByName: 'Rahul',
    nextFollowupAt: new Date('2026-07-13T10:00:00+05:30').toISOString(),
  });
  assert.ok(msg.startsWith('Call attempted by Rahul — No answer.'));
  assert.ok(msg.includes('Next attempt scheduled for'));
});

run('activity message with no next follow-up omits the scheduling sentence', () => {
  const msg = buildActivityMessage({ outcome: 'not_interested', attemptedByName: 'Priya' });
  assert.strictEqual(msg, 'Call attempted by Priya — Not interested.');
});

run('activity message for connected includes the conversation result', () => {
  const msg = buildActivityMessage({ outcome: 'connected', conversationResult: 'demo_booked', attemptedByName: 'Aisha' });
  assert.strictEqual(msg, 'Call attempted by Aisha — Connected — Demo booked.');
});

// ── Display status derivation ───────────────────────────────────────────

run('scheduled + future date -> "scheduled"', () => {
  assert.strictEqual(computeDisplayStatus({ status: 'scheduled', next_followup_at: inFuture(120) }), 'scheduled');
});

run('scheduled + within 30 min -> "due"', () => {
  assert.strictEqual(computeDisplayStatus({ status: 'scheduled', next_followup_at: inFuture(10) }), 'due');
});

run('scheduled + past date -> "overdue"', () => {
  assert.strictEqual(computeDisplayStatus({ status: 'scheduled', next_followup_at: inPast(5) }), 'overdue');
});

run('non-scheduled status passes through unchanged regardless of date', () => {
  assert.strictEqual(computeDisplayStatus({ status: 'attempted', next_followup_at: inPast(1000) }), 'attempted');
  assert.strictEqual(computeDisplayStatus({ status: 'completed', next_followup_at: inFuture(1000) }), 'completed');
});

console.log('All followupOutcome tests passed.');
