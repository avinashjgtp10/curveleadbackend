const test = require('node:test');
const assert = require('node:assert/strict');
const { previousRange } = require('../controllers/reportsController');

const d = (s) => new Date(s);

test('a month in progress is compared with the same days of the previous month', () => {
  const r = previousRange({ start: d('2026-10-01T00:00:00Z'), end: d('2026-11-01T00:00:00Z'), period: 'this_month', now: d('2026-10-04T12:00:00Z') });
  assert.equal(r.prevStart.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(r.prevEnd.toISOString(), '2026-09-04T12:00:00.000Z');
});

test('a finished month is compared with the whole previous month', () => {
  const r = previousRange({ start: d('2026-09-01T00:00:00Z'), end: d('2026-10-01T00:00:00Z'), period: 'last_month', now: d('2026-10-04T12:00:00Z') });
  assert.equal(r.prevStart.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(r.prevEnd.toISOString(), '2026-09-01T00:00:00.000Z');
});

test('rolling and custom ranges step back by their own length', () => {
  const r = previousRange({ start: d('2026-09-04T00:00:00Z'), end: d('2026-10-04T00:00:00Z'), period: 'last_30_days', now: d('2026-10-04T12:00:00Z') });
  assert.equal(r.prevStart.toISOString(), '2026-08-05T00:00:00.000Z');
  assert.equal(r.prevEnd.toISOString(), '2026-09-04T00:00:00.000Z');
});
