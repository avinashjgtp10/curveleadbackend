const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// Batch 1 (A): "won" is a stage flag, so the flag itself needs guarding.
// stageRules / fixStageFlags require config/db at load; stub it so the pure parts load offline.
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (/config\/db$/.test(req)) return { query: async () => ({ rows: [] }), pool: { end() {} } };
  return realLoad.call(this, req, ...rest);
};
const { stageFlagError } = require('../utils/stageRules');
const { classifyStages } = require('../scripts/fixStageFlags');
Module._load = realLoad;

test('a stage cannot be both won and lost, and the first stage cannot be won', () => {
  assert.match(stageFlagError({ isWon: true, isLost: true }), /not both/);
  assert.match(stageFlagError({ isWon: true, isFirst: true }), /first stage/);
  assert.equal(stageFlagError({ isWon: true, isFirst: false }), null);
  assert.equal(stageFlagError({ isLost: true, isFirst: true }), null);
});

test('fixStageFlags: first stage flagged won is auto-fixed; early-looking ones only flagged for review', () => {
  const r = classifyStages([
    { id: 'new', name: 'New', pos: 1, is_won: true, is_active: true },
    { id: 'ree', name: 'Interested', pos: 2, is_won: true, is_active: true },
    { id: 'lead', name: 'Site visit', pos: 3, is_won: true, is_active: true, meta_event_name: 'Lead' },
    { id: 'won', name: 'Won', pos: 4, is_won: true, is_active: true },
    { id: 'conv', name: 'Converted', pos: 5, is_won: true, is_active: true, meta_event_name: 'Purchase' },
    { id: 'both', name: 'Closed', pos: 6, is_won: true, is_lost: true, is_active: true },
  ]);
  const by = Object.fromEntries(r.map(x => [x.id, x.action]));
  assert.deepEqual(by, { new: 'auto', ree: 'review', lead: 'review', both: 'auto' });
});

test('fixStageFlags: inactive stages do not decide which stage is first', () => {
  const r = classifyStages([
    { id: 'old', name: 'Old', pos: 0, is_won: false, is_active: false },
    { id: 'new', name: 'New', pos: 1, is_won: true, is_active: true },
  ]);
  assert.equal(r[0].action, 'auto');
});
