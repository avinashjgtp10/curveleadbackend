const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const quality = require('../utils/dataQuality');

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { module, exports: module.exports, console, Buffer, Date, Set, Map, JSON, process, require: key => deps[key] || {} });
  return module.exports;
}
const response = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

function controller() {
  const ingested = [];
  const c = load('controllers/leadController.js', {
    '../utils/dataQuality': quality, '../utils/importPhone': require('../utils/importPhone'),
    '../utils/workspaceLocale': { getWorkspaceLocale: async () => ({ country: 'IN' }), localeFromSettings: () => ({ country: 'IN' }) },
    '../services/leadIngestion': { ingestLead: async (id, data) => { ingested.push(data.phone); return { lead: { id: 'x', lead_number: 'LD-1', ...data } }; } },
    '../config/db': { query: async () => ({ rows: [] }) }, xlsx: require('xlsx'),
  });
  return { c, ingested };
}
// A file with two good rows, a ".0" spreadsheet number (rescued), and two bad ones.
const CSV = 'name,phone\nAsha,9876543210\nBen,919876543211.0\nCara,call me\nDev,12345\n';
const req = (body = {}) => ({ tenantId: 't', user: { id: 'u', role: 'admin' }, body, file: { originalname: 'leads.csv', buffer: Buffer.from(CSV) } });

test('by default a file with bad phones is refused whole, and every bad row is listed with a reason', async () => {
  const { c, ingested } = controller();
  const res = response();
  await c.importLeads(req(), res);
  assert.equal(res.code, 422);
  assert.equal(ingested.length, 0, 'nothing is written');
  assert.equal(res.data.can_skip, true);
  assert.equal(res.data.invalid_count, 2);
  assert.equal(JSON.stringify(res.data.errors.map(e => [e.row, e.name, e.phone])), JSON.stringify([[4, 'Cara', 'call me'], [5, 'Dev', '12345']]));
  assert.match(res.data.errors[0].error, /letters/);
  assert.match(res.data.errors[1].error, /Too few/);
});

test('with skip_invalid the good rows (including the ".0" one) are imported and the bad ones reported', async () => {
  const { c, ingested } = controller();
  const res = response();
  await c.importLeads(req({ skip_invalid: 'true' }), res);
  assert.equal(res.code, 200);
  assert.equal(JSON.stringify(ingested), JSON.stringify(['+919876543210', '+919876543211']));
  assert.equal(res.data.inserted, 2);
  assert.equal(res.data.skipped, 2);
  assert.equal(res.data.invalid, 2);
  assert.equal(JSON.stringify(res.data.errors.map(e => e.row)), '[4,5]');
});

test('a clean file imports with or without the option', async () => {
  const { c, ingested } = controller();
  const clean = { ...req(), file: { originalname: 'ok.csv', buffer: Buffer.from('name,phone\nAsha,9876543210\n') } };
  const res = response();
  await c.importLeads(clean, res);
  assert.equal(res.code, 200);
  assert.equal(ingested.length, 1);
});
