const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, phoneDigitVariants } = require('../utils/dataQuality');
const { planMerge } = require('../services/leadMerge');
const { analyseTenant } = require('../scripts/mergeDuplicateLeads');

// Batch 1 (B): one E.164 number per contact, read in the workspace's country, and the
// agreed merge rules.

test('every Indian format of a number normalises to the same E.164', () => {
  for (const v of ['9876543210', '919876543210', '+91 98765-43210', '098765 43210', '00919876543210', '(+91) 98765 43210']) {
    assert.equal(normalizePhone(v), '+919876543210', v);
  }
});

test('numbers without a country code are read in the workspace country', () => {
  assert.equal(normalizePhone('(213) 373-4253', 'US'), '+12133734253');
  assert.equal(normalizePhone('050 123 4567', 'AE'), '+971501234567');
  assert.equal(normalizePhone('07911 123456', 'GB'), '+447911123456');
  assert.throws(() => normalizePhone('050 123 4567', 'IN'), { status: 422 });   // not an Indian number
  assert.equal(normalizePhone('+971501234567', 'IN'), '+971501234567');        // explicit code always wins
});

test('invalid and placeholder numbers are rejected', () => {
  for (const v of ['+99917935110', '999999999999999999999999', '<test lead: dummy data for phone_number>', '123', 'abc8980235151', '']) {
    assert.throws(() => normalizePhone(v), { status: 422 }, v);
  }
});

test('legacy stored formats of a number are all matchable', () => {
  assert.deepEqual(phoneDigitVariants('+919876543210'), ['919876543210', '9876543210', '09876543210']);
});

const stageFlags = new Map([['new', {}], ['qualified', {}], ['won', { is_won: true }], ['lost', { is_lost: true }]]);
const L = (id, created, extra = {}) => ({ id, created_at: created, updated_at: created, name: 'Priya', stage: 'New', source: 'manual', tags: [], custom_fields: {}, ...extra });

test('the oldest lead is kept and blanks are filled from the newest duplicate', () => {
  const plan = planMerge([
    L('b', '2026-09-20', { email: 'new@x.in', city: 'Pune' }),
    L('a', '2026-08-01', { name: 'Unknown', email: null }),
    L('c', '2026-09-25', { email: 'newest@x.in', name: 'Priya Sharma' }),
  ], { stageFlags });
  assert.equal(plan.keepId, 'a');
  assert.deepEqual(plan.mergedIds, ['b', 'c']);
  assert.equal(plan.patch.email, 'newest@x.in');
  assert.equal(plan.patch.city, 'Pune');
  assert.equal(plan.patch.name, 'Priya Sharma');
});

test('stage: most recent change wins, but a Won/Lost lead never moves back', () => {
  const lastStageChange = new Map([['a', '2026-08-05'], ['b', '2026-09-21'], ['c', '2026-09-26']]);
  let plan = planMerge([L('a', '2026-08-01'), L('b', '2026-09-20', { stage: 'Qualified' }), L('c', '2026-09-25', { stage: 'New' })], { stageFlags, lastStageChange });
  assert.equal(plan.patch.stage, undefined, 'c (New) is most recent — same as the kept lead');
  plan = planMerge([L('a', '2026-08-01'), L('b', '2026-09-20', { stage: 'Qualified' })], { stageFlags, lastStageChange });
  assert.equal(plan.patch.stage, 'Qualified');
  plan = planMerge([L('a', '2026-08-01', { stage: 'Won', won_at: '2026-08-05' }), L('b', '2026-09-20', { stage: 'Qualified' })], { stageFlags, lastStageChange });
  assert.equal(plan.patch.stage, undefined, 'kept Won lead stays Won despite a newer non-terminal duplicate');
  plan = planMerge([L('a', '2026-08-01', { stage: 'New' }), L('b', '2026-09-20', { stage: 'Lost' }), L('c', '2026-09-25', { stage: 'New' })], { stageFlags, lastStageChange });
  assert.equal(plan.patch.stage, 'Lost', 'a terminal stage beats a newer non-terminal one');
});

test('owner = user behind the most recent human activity; first-touch attribution kept, others logged', () => {
  const lastHuman = new Map([['a', { at: '2026-08-02', userId: 'u1' }], ['b', { at: '2026-09-22', userId: 'u2' }]]);
  const plan = planMerge([
    L('a', '2026-08-01', { assigned_to: 'u1', source: 'manual' }),
    L('b', '2026-09-20', { assigned_to: 'u1', source: 'meta_ads', meta_lead_id: 'M1', campaign_id: 'C9' }),
  ], { stageFlags, lastHuman });
  assert.equal(plan.patch.assigned_to, 'u2');
  assert.equal(plan.patch.source, undefined);
  assert.equal(plan.patch.meta_lead_id, undefined, 'provider ids stay on their own (merged) row');
  assert.deepEqual(plan.otherTouches, [{ lead_id: 'b', source: 'meta_ads', campaign_id: 'C9', meta_lead_id: 'M1', created_at: '2026-09-20' }]);
});

test('dry-run analysis groups by E.164 per workspace country and lists invalid numbers', () => {
  const { duplicates, reformat, invalid } = analyseTenant([
    { id: '1', phone: '9876543210' }, { id: '2', phone: '+919876543210' }, { id: '3', phone: '919876543210' },
    { id: '4', phone: '9123456789' }, { id: '5', phone: '<test lead: dummy data for phone_number>' },
  ], 'IN');
  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0][1].map(l => l.id), ['1', '2', '3']);
  assert.deepEqual(reformat.map(r => r.id), ['1', '3', '4']);
  assert.deepEqual(invalid.map(i => i.id), ['5']);
});
