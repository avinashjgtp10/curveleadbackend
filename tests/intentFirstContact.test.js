const test = require('node:test');
const assert = require('node:assert/strict');
const { computeIntentScore } = require('../services/intentScoring');

test('a new, never-contacted lead is told to make first contact fast', () => {
  const r = computeIntentScore({ lead: { stage: 'New', lead_status: null, last_contacted_at: null }, followupHealth: 'good' });
  assert.match(r.suggested_action, /within 5 minutes/);
  assert.doesNotMatch(r.reason, /won/i);
});

test('a contacted lead keeps the normal follow-up advice', () => {
  const r = computeIntentScore({ lead: { stage: 'Contacted', last_contacted_at: new Date().toISOString() }, followupHealth: 'good' });
  assert.equal(r.suggested_action, 'Continue planned follow-up');
});

test('won leads still read as closed', () => {
  assert.equal(computeIntentScore({ lead: {}, isWon: true }).intent_score, 100);
});
