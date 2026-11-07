const test = require('node:test');
const assert = require('node:assert/strict');
const { leadTimezone, businessWindow, deferForStepHours, nextWindowStart } = require('../utils/leadTimezone');

const ws = (over = {}) => ({ timezone: 'Asia/Kolkata', country: 'IN', ...over }); // workspace settings: India
const iso = (d) => (d ? d.toISOString() : null);
const step = { business_hours_only: true };

test('the lead\'s zone comes from their number only for countries with one time zone', () => {
  assert.equal(leadTimezone({ phone: '+971501234567' }, ws()), 'Asia/Dubai');
  assert.equal(leadTimezone({ phone: '+6591234567' }, ws()), 'Asia/Singapore');
  assert.equal(leadTimezone({ phone: '+919665624277' }, ws({ timezone: 'Asia/Dubai', country: 'AE' })), 'Asia/Kolkata');
  assert.equal(leadTimezone({ phone: '9665624277' }, ws()), 'Asia/Kolkata');                  // a local-format number read in the workspace's country
  assert.equal(leadTimezone({ phone: '+14155552671' }, ws()), 'Asia/Kolkata');                 // US has several zones: fall back to the workspace's
  assert.equal(leadTimezone({ phone: '+61412345678' }, ws({ timezone: 'Asia/Dubai' })), 'Asia/Dubai');
  assert.equal(leadTimezone({ phone: '123' }, ws()), 'Asia/Kolkata');                           // unreadable
  for (const phone of [null, undefined, '', 'abc']) assert.equal(leadTimezone({ phone }, ws()), 'Asia/Kolkata');
  assert.equal(leadTimezone(undefined, undefined) .length > 0, true);                            // never throws
});
test('the window is the workspace\'s automation hours with the same defaults', () => {
  assert.deepEqual(businessWindow({}), { start: '09:00', end: '20:00' });
  assert.deepEqual(businessWindow({ automation_business_hours_start: '10:00', automation_business_hours_end: '18:30' }), { start: '10:00', end: '18:30' });
});
test('a flagged step is sent inside the lead\'s hours and held outside them, until the next opening in the lead\'s zone', () => {
  const dubai = { phone: '+971501234567' };
  // 06:00Z = 10:00 Dubai (inside 09:00-20:00)
  assert.equal(deferForStepHours(step, dubai, ws(), new Date('2026-06-01T06:00:00Z')), null);
  // 16:30Z = 20:30 Dubai: closed, next opening is 09:00 Dubai tomorrow = 05:00Z
  assert.equal(iso(deferForStepHours(step, dubai, ws(), new Date('2026-06-01T16:30:00Z'))), '2026-06-02T05:00:00.000Z');
  // 02:00Z = 06:00 Dubai: not open yet, opens 09:00 Dubai today = 05:00Z
  assert.equal(iso(deferForStepHours(step, dubai, ws(), new Date('2026-06-01T02:00:00Z'))), '2026-06-01T05:00:00.000Z');
  // exactly at opening is inside; exactly at closing is outside
  assert.equal(deferForStepHours(step, dubai, ws(), new Date('2026-06-01T05:00:00Z')), null);
  assert.ok(deferForStepHours(step, dubai, ws(), new Date('2026-06-01T16:00:00Z')));
});
test('the same moment is inside for one lead and outside for another (that is the point)', () => {
  const now = new Date('2026-06-01T04:00:00Z'); // 09:30 in India, 08:00 in Dubai
  assert.equal(deferForStepHours(step, { phone: '+919665624277' }, ws(), now), null);
  assert.equal(iso(deferForStepHours(step, { phone: '+971501234567' }, ws(), now)), '2026-06-01T05:00:00.000Z');
});
test('custom hours are respected, and unflagged steps are never held', () => {
  const settings = ws({ automation_business_hours_start: '10:00', automation_business_hours_end: '12:00' });
  assert.ok(deferForStepHours(step, { phone: '+919665624277' }, settings, new Date('2026-06-01T04:00:00Z')));        // 09:30 IST is before 10:00
  assert.equal(deferForStepHours(step, { phone: '+919665624277' }, settings, new Date('2026-06-01T05:00:00Z')), null); // 10:30 IST
  for (const s of [undefined, {}, { business_hours_only: false }]) assert.equal(deferForStepHours(s, { phone: '+971501234567' }, ws(), new Date('2026-06-01T20:00:00Z')), null);
});
test('a lead whose zone cannot be told uses the workspace zone', () => {
  const dubaiWorkspace = ws({ timezone: 'Asia/Dubai', country: 'AE' });
  assert.equal(deferForStepHours(step, { phone: '+14155552671' }, dubaiWorkspace, new Date('2026-06-01T06:00:00Z')), null);   // 10:00 Dubai
  assert.equal(iso(deferForStepHours(step, { phone: '+14155552671' }, dubaiWorkspace, new Date('2026-06-01T16:30:00Z'))), '2026-06-02T05:00:00.000Z');
});
test('the next opening handles a time zone with a UTC offset that is not whole hours', () => {
  assert.equal(iso(nextWindowStart('Asia/Kolkata', { start: '09:00', end: '20:00' }, new Date('2026-06-01T15:00:00Z'))), '2026-06-02T03:30:00.000Z'); // 20:30 IST -> 09:00 IST next day
});
