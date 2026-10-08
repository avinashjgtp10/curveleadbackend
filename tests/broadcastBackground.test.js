const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, process: { env: {} }, setTimeout, require: k => deps[k] || {} });
  return module.exports;
}
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const ids = n => Array.from({ length: n }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);

// Sends are held until release() so the test can observe a broadcast mid-run.
function setup() {
  let release;
  const gate = new Promise(r => { release = r; });
  const db = {
    query: async (sql, p) => {
      if (sql.includes('SELECT settings')) return { rows: [{ settings: { whatsapp_business_account_id: 'w', whatsapp_access_token: 't', whatsapp_messaging_limit: 1000 } }] };
      if (sql.includes('SELECT id FROM leads WHERE tenant_id=$1 AND id=ANY')) return { rows: p[1].map(id => ({ id })) };
      if (sql.includes('INSERT INTO whatsapp_broadcast_reports')) return { rows: [{ id: 'report-1' }] };
      if (sql.includes('SELECT l.id, l.name')) return { rows: p[1].map(id => ({ id, name: 'Lead', phone: id.slice(-4), source: 'meta_ads' })) };
      if (sql.includes('count(*)::int n')) return { rows: [{ n: 0, known: false }] };
      return { rows: [] };
    },
  };
  db.transaction = fn => fn(db);
  const ctrl = load('controllers/whatsappBroadcastController.js', {
    '../services/whatsappConsent': require('../services/whatsappConsent'),
    '../config/db': db,
    '../utils/messagingLimit': { messagingLimit: async () => 1000 },
    '../utils/whatsappCredentials': { resolveWhatsAppCredentials: async () => ({}) },
    '../services/whatsappService': {
      listMessageTemplates: async () => ({ templates: [{ name: 'promo', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }] }),
      sendTemplate: async () => { await gate; return { success: true, wa_message_id: 'wa' }; },
    },
  });
  const req = n => ({ tenantId: 't1', user: { id: 'u1', role: 'admin' }, body: {
    lead_ids: ids(n), template_name: 'promo', language_code: 'en_US', variable_mapping: [{ position: 1, source: 'field', value: 'name' }],
  } });
  return { ctrl, req, release };
}

test('send answers immediately with a broadcast id; progress shows the run and its final result', async () => {
  const { ctrl, req, release } = setup();
  const r = res();
  await ctrl.sendBroadcast(req(2), r);
  assert.equal(r.code, 202);
  assert.deepEqual({ ...r.data }, { started: true, broadcast_id: 'report-1', total: 2 });

  let p = res();
  ctrl.getBroadcastProgress({ params: { id: 'report-1' }, tenantId: 't1' }, p);
  assert.equal(p.data.done, false);

  // Another workspace can't read it.
  p = res();
  ctrl.getBroadcastProgress({ params: { id: 'report-1' }, tenantId: 'other' }, p);
  assert.equal(p.code, 404);

  release();
  for (let i = 0; i < 50 && !p.data?.done; i++) {
    await new Promise(r => setTimeout(r, 50));
    p = res();
    ctrl.getBroadcastProgress({ params: { id: 'report-1' }, tenantId: 't1' }, p);
  }
  assert.equal(p.data.done, true);
  assert.equal(p.data.sent, 2);
  assert.equal(p.data.results.length, 2);
});

test('a second send of the same template is refused while the first is still running', async () => {
  const { ctrl, req, release } = setup();
  await ctrl.sendBroadcast(req(2), res());
  const second = res();
  await ctrl.sendBroadcast(req(2), second);
  assert.equal(second.code, 409);
  assert.match(second.data.error, /already being sent/);
  release();
});

test('validation errors still come back on the request itself', async () => {
  const { ctrl, req } = setup();
  const bad = req(1);
  bad.body.template_name = 'missing';
  const r = res();
  await ctrl.sendBroadcast(bad, r);
  assert.equal(r.code, 422);
  assert.match(r.data.error, /not approved/);
});

test('a lead update failing after a successful send still counts the message as sent', async () => {
  const db = {
    query: async (sql, p) => {
      if (sql.includes('SELECT settings')) return { rows: [{ settings: { whatsapp_business_account_id: 'w', whatsapp_access_token: 't', whatsapp_messaging_limit: 1000 } }] };
      if (sql.includes('INSERT INTO whatsapp_broadcast_reports')) return { rows: [{ id: 'r' }] };
      if (sql.includes('SELECT l.id, l.name')) return { rows: [{ id: 'a', name: 'A', phone: '1', source: 'meta_ads' }] };
      if (sql.includes('count(*)::int n')) return { rows: [{ n: 0, known: false }] };
      if (sql.startsWith('UPDATE leads SET last_contacted_at')) throw Object.assign(new Error('violates check constraint "leads_source_canonical"'), { code: '23514' });
      return { rows: [] };
    },
  };
  db.transaction = fn => fn(db);
  const ctrl = load('controllers/whatsappBroadcastController.js', {
    '../services/whatsappConsent': require('../services/whatsappConsent'),
    '../config/db': db,
    '../utils/messagingLimit': { messagingLimit: async () => 1000 },
    '../utils/whatsappCredentials': { resolveWhatsAppCredentials: async () => ({}) },
    '../services/whatsappService': {
      listMessageTemplates: async () => ({ templates: [{ name: 'promo', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi' }] }] }),
      sendTemplate: async () => ({ success: true, wa_message_id: 'wa' }),
    },
  });
  const result = await ctrl.executeBroadcast({ tenantId: 't', userId: 'u', lead_ids: ['a'], template_name: 'promo', language_code: 'en_US', mapping: [] });
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
});
