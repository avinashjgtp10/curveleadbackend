const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Code deployed before its migration: clear 503s naming the migration, and Meta leads /
// CAPI events still recorded instead of failing.

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, process: { env: {} }, setTimeout, require: k => deps[k] || {} });
  return module.exports;
}
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const pgError = (code, message) => Object.assign(new Error(message), { code });

test('schema errors name the migration to run', () => {
  const { isSchemaError, schemaErrorMessage } = require('../utils/schemaErrors');
  assert.ok(isSchemaError(pgError('42P01', 'relation "ad_lead_forms" does not exist')));
  assert.ok(!isSchemaError(pgError('23505', 'duplicate key')));
  assert.match(schemaErrorMessage(pgError('42P01', 'relation "ad_lead_forms" does not exist')), /migration_ads_phase2\.sql/);
  assert.match(schemaErrorMessage(pgError('42P01', 'relation "ad_ai_drafts" does not exist')), /migration_ads_phase5\.sql/);
  assert.match(schemaErrorMessage(pgError('42703', 'column "something_else" does not exist')), /database update/);
});

test('GET /api/ads/forms before the Phase 2 migration answers 503 with the reason, not "Failed."', async () => {
  const ctrl = load('controllers/adsController.js', {
    '../utils/schemaErrors': require('../utils/schemaErrors'),
    '../services/metaLeads': { listForms: async () => { throw pgError('42P01', 'relation "ad_lead_forms" does not exist'); } },
  });
  const r = res();
  await ctrl.listLeadForms({ tenantId: 't' }, r);
  assert.equal(r.code, 503);
  assert.equal(r.data.code, 'MIGRATION_PENDING');
  assert.match(r.data.error, /migration_ads_phase2\.sql/);
});

test('unexpected errors keep a readable message instead of "Failed."', async () => {
  const ctrl = load('controllers/adsController.js', {
    '../utils/schemaErrors': require('../utils/schemaErrors'),
    '../services/metaLeads': { listForms: async () => { throw new Error('socket hang up'); } },
  });
  const r = res();
  await ctrl.listLeadForms({ tenantId: 't' }, r);
  assert.equal(r.code, 500);
  assert.equal(r.data.error, 'List lead forms failed. Please try again.');
});

test('lead ingestion leaves out meta_form_id until that column exists', async () => {
  const run = async (hasColumn) => {
    let insertSql;
    const client = { query: async (sql) => {
      if (sql.includes('information_schema.columns')) return { rows: hasColumn ? [{ column_name: 'meta_form_id' }] : [] };
      if (sql.startsWith('INSERT INTO leads')) { insertSql = sql; return { rows: [{ id: 'l1' }] }; }
      if (sql.startsWith('SELECT settings')) return { rows: [{ settings: { dedupe_mode: 'off' } }] };
      return { rows: [] };
    } };
    const ingestion = load('services/leadIngestion.js', {
      '../config/db': { transaction: (fn) => fn(client) },
      '../utils/leadAssignment': { assignInTransaction: async (c, t, lead) => lead },
      '../utils/leadNumber': { nextLeadNumber: async () => 1 },
      '../utils/dataQuality': { normalizeLead: (d) => ({ ...d, phone: '+919876543210' }), normalizePhone: (p) => p, phoneDigitVariants: () => [] },
      '../utils/workspaceLocale': { localeFromSettings: () => ({ country: 'IN' }) },
    });
    await ingestion.ingestLead('t', { name: 'A', phone: '9876543210', source: 'meta_ads', meta_lead_id: 'L1', meta_form_id: 'F1' }, { submissionKey: null });
    return insertSql;
  };
  assert.doesNotMatch(await run(false), /meta_form_id/);
  assert.match(await run(true), /meta_form_id/);
});

test('a CAPI event that reached Meta is still logged before the Phase 4 index exists', async () => {
  const inserts = [];
  const capi = load('utils/metaCapi.js', {
    crypto: require('crypto'),
    '../config/meta': { GRAPH_URL: 'https://graph' },
    axios: { post: async () => ({ data: { events_received: 1 } }) },
    '../config/db': { query: async (sql, p) => {
      if (sql.startsWith('SELECT')) return { rows: [{ settings: { meta_capi_enabled: true, meta_dataset_id: 'D', meta_capi_access_token: 't' } }] };
      if (sql.includes('ON CONFLICT')) throw pgError('42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
      inserts.push(p); return { rows: [] };
    } },
  });
  assert.equal(await capi.sendLeadConversionEvent({ tenantId: 't', lead: { id: 'l', meta_lead_id: 'm' }, eventName: 'QualifiedLead' }), 'success');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][3], 'success');
});
