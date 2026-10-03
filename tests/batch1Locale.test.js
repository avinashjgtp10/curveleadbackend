const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const locale = require('../utils/workspaceLocale');
const { countryProfile, bankLabel } = require('../utils/countryProfiles');
const { isWithinBusinessHours } = require('../utils/businessHours');

// Batch 1 (E): workspace country / currency / timezone.

test('money is formatted in its own currency with the country’s grouping, never converted', () => {
  const fm = (...a) => locale.formatMoney(...a).replace(/\u00a0/g, ' ');
  assert.equal(fm(125000, { currency: 'INR', country: 'IN' }), '₹1,25,000');
  assert.equal(fm(1250.5, { currency: 'AED', country: 'AE' }), 'AED 1,250.50');
  assert.equal(fm(99, { currency: 'USD', country: 'US', display: 'code', decimals: 2 }), 'USD 99.00');
  assert.equal(fm(null), '—');
});

test('settings fall back to India defaults only for missing or invalid values', () => {
  assert.deepEqual(locale.localeFromSettings({}), { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' });
  assert.deepEqual(locale.localeFromSettings({ country: 'AE', currency: 'AED', timezone: 'Asia/Dubai' }), { country: 'AE', currency: 'AED', timezone: 'Asia/Dubai' });
  assert.equal(locale.localeFromSettings({ currency: 'XYZW', timezone: 'Mars/Base' }).timezone, 'Asia/Kolkata');
});

test('an AI booking time without an offset is read in the workspace timezone', () => {
  assert.equal(locale.wallTimeToUtc('2026-10-04T15:30:00', 'Asia/Kolkata').toISOString(), '2026-10-04T10:00:00.000Z');
  assert.equal(locale.wallTimeToUtc('2026-10-04T15:30', 'Asia/Dubai').toISOString(), '2026-10-04T11:30:00.000Z');
  assert.equal(locale.wallTimeToUtc('2026-07-04T09:00', 'America/New_York').toISOString(), '2026-07-04T13:00:00.000Z', 'daylight saving');
  assert.equal(locale.wallTimeToUtc('2026-10-04T10:00:00Z', 'Asia/Dubai').toISOString(), '2026-10-04T10:00:00.000Z', 'explicit Z kept');
  assert.equal(locale.wallTimeToUtc('not a date', 'Asia/Dubai'), null);
});

test('tax and bank fields follow the country', () => {
  assert.deepEqual(countryProfile('IN').tax.map(f => f.label), ['GSTIN', 'PAN']);
  assert.ok(countryProfile('IN').bank.some(f => f.key === 'ifsc'));
  assert.equal(countryProfile('AE').tax[0].label, 'TRN (VAT registration)');
  assert.ok(countryProfile('AE').bank.some(f => f.key === 'iban') && !countryProfile('AE').bank.some(f => f.key === 'ifsc'));
  assert.equal(countryProfile('US').tax[0].label, 'EIN');
  assert.equal(countryProfile('ZZ').tax[0].label, 'Tax ID');
  assert.equal(bankLabel('AE', 'ifsc'), 'IFSC', 'old India fields still get a label');
});

test('daily report goes out at the configured time in the workspace timezone', () => {
  const { isWithinSendWindow } = require('../jobs/dailyReportEmail');
  const at = (iso) => new Date(iso);
  assert.ok(isWithinSendWindow(at('2026-10-04T02:35:00Z'), '08:00', 'Asia/Kolkata'), '08:05 IST');
  assert.ok(!isWithinSendWindow(at('2026-10-04T08:05:00Z'), '08:00', 'Asia/Kolkata'), '13:35 IST');
  assert.ok(isWithinSendWindow(at('2026-10-04T04:05:00Z'), '08:00', 'Asia/Dubai'), '08:05 Dubai');
  assert.ok(isWithinSendWindow(at('2026-10-04T12:10:00Z'), '08:00', 'America/New_York'), '08:10 New York (EDT)');
});

test('WhatsApp business hours use the workspace timezone over the one saved with the hours', () => {
  const hours = { start: '10:00', end: '19:00', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Kolkata' };
  const now = new Date('2026-10-04T15:00:00Z'); // 20:30 IST, 19:00 Dubai, 11:00 New York
  assert.equal(isWithinBusinessHours(hours, now), false, 'saved Kolkata');
  assert.equal(isWithinBusinessHours(hours, now, 'America/New_York'), true);
});

// automationSequenceRunner pulls in DB/WhatsApp modules; stub them so the pure helpers load.
const withStubs = (fn) => {
  const real = Module._load;
  Module._load = function (req, ...rest) {
    if (/config\/db$|whatsappService$|groqService$|utils\/email$|whatsappConsent$/.test(req)) return { query: async () => ({ rows: [] }) };
    return real.call(this, req, ...rest);
  };
  try { return fn(); } finally { Module._load = real; }
};

test('automation business hours are local time, and the next window opens at local start', () => {
  const r = withStubs(() => require('../jobs/automationSequenceRunner'));
  const s = { automation_business_hours_enabled: true, automation_business_hours_start: '09:00', automation_business_hours_end: '20:00', timezone: 'Asia/Kolkata' };
  assert.equal(r.isWithinBusinessHours(s, new Date('2026-10-04T04:00:00Z')), true, '09:30 IST');
  assert.equal(r.isWithinBusinessHours(s, new Date('2026-10-04T15:00:00Z')), false, '20:30 IST (was "open" when compared in UTC)');
  assert.equal(r.nextBusinessWindowStart(s, new Date('2026-10-04T15:00:00Z')).toISOString(), '2026-10-05T03:30:00.000Z', 'tomorrow 09:00 IST');
  assert.equal(r.nextBusinessWindowStart(s, new Date('2026-10-04T01:00:00Z')).toISOString(), '2026-10-04T03:30:00.000Z', 'today 09:00 IST');
});

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, Intl, Object, Array, process: { env: {} }, setTimeout, require: k => deps[k] || {} });
  return module.exports;
}
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

const settingsCtrl = ({ current = {}, hasMoney }) => {
  const writes = [];
  const db = { query: async (sql, p) => {
    if (sql.includes('SELECT settings FROM tenants')) return { rows: [{ settings: current }] };
    if (sql.includes('AS has')) return { rows: [{ has: hasMoney }] };
    if (sql.startsWith('UPDATE tenants')) { writes.push(JSON.parse(p[1])); return { rows: [{ settings: { ...current, ...JSON.parse(p[1]) } }] }; }
    return { rows: [] };
  } };
  const ctrl = load('controllers/settingsController.js', { '../config/db': db, '../utils/workspaceLocale': locale, '../utils/stageRules': {} });
  return { ctrl, writes };
};

test('changing currency once money is recorded needs confirmation, and is logged', async () => {
  const { ctrl, writes } = settingsCtrl({ hasMoney: true });
  const r1 = res();
  await ctrl.updateSettings({ tenantId: 't', user: { id: 'u' }, body: { currency: 'AED' } }, r1);
  assert.equal(r1.code, 409);
  assert.equal(r1.data.code, 'CURRENCY_CHANGE_CONFIRM');
  assert.match(r1.data.error, /won't be converted from INR to AED/);
  assert.equal(writes.length, 0);

  const r2 = res();
  await ctrl.updateSettings({ tenantId: 't', user: { id: 'u' }, body: { currency: 'AED', confirm_currency_change: true } }, r2);
  assert.equal(r2.code, 200);
  assert.equal(writes[0].currency, 'AED');
  assert.deepEqual(writes[0].currency_history.map(h => [h.from, h.to]), [['INR', 'AED']]);
  assert.equal(r2.data.settings.currency, 'AED');
});

test('a new workspace can set country, currency and timezone without a warning; bad values are refused', async () => {
  const { ctrl, writes } = settingsCtrl({ hasMoney: false });
  const r = res();
  await ctrl.updateSettings({ tenantId: 't', user: { id: 'u' }, body: { country: 'AE', currency: 'AED', timezone: 'Asia/Dubai' } }, r);
  assert.equal(r.code, 200);
  assert.deepEqual([writes[0].country, writes[0].currency, writes[0].timezone], ['AE', 'AED', 'Asia/Dubai']);
  for (const body of [{ timezone: 'Mars/Base' }, { currency: 'RUPEES' }, { country: 'India' }]) {
    const bad = res();
    await ctrl.updateSettings({ tenantId: 't', user: { id: 'u' }, body }, bad);
    assert.equal(bad.code, 422, JSON.stringify(body));
  }
});
