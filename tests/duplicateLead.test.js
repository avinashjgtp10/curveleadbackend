const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const quality = require('../utils/dataQuality');

// Duplicate lead validation: adding a lead whose MOBILE NUMBER already exists is refused (409) with a clear
// message and a pointer to the existing lead. Only the phone number is compared — never the email.

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { module, exports: module.exports, console, Buffer, Date, Set, Map, JSON, process, require: key => deps[key] || {} });
  return module.exports;
}
const response = () => ({ code: 200, status(c) { this.code = c; return this; }, json(data) { this.data = data; return this; } });

const existingLead = { id: 'lead-1', lead_number: 'LD-00007', name: 'Priya Shah', phone: '+919876543210', assigned_to: 'user-9', tenant_id: 't1' };
const NEW_MSG = 'This mobile number already exists.';

function controllerWith(ingest, found = undefined) {
  const calls = [];
  const controller = load('controllers/leadController.js', {
    '../utils/dataQuality': quality,
    '../utils/workspaceLocale': { getWorkspaceLocale: async () => ({ country: 'IN' }), localeFromSettings: () => ({ country: 'IN' }) },
    '../services/leadIngestion': {
      ingestLead: async (tenantId, data, options) => { calls.push({ tenantId, data, options }); return ingest(data); },
      findLeadByPhone: async (db, tenantId, phone) => { calls.push({ lookup: { tenantId, phone } }); return found; },
    },
    '../config/db': { query: async () => ({ rows: [] }) },
    './notificationController': { createNotification: async () => {}, notifyNewLeadToAdmins: async () => {} },
    '../utils/automationTriggers': { checkNewLeadTriggers: async () => {} },
    '../utils/leadAssignment': { applyAssignmentRules: async () => {} },
    '../utils/leadNotifyEmail': { notifyNewLead: async () => {} },
  });
  return { controller, calls };
}
const request = (role = 'admin', body = {}) => ({ tenantId: 't1', user: { id: 'user-1', role }, body: { name: 'Priya', phone: '9876543210', ...body } });

test('a duplicate mobile number is refused with 409, a clear message and the existing lead', async () => {
  const { controller, calls } = controllerWith(() => ({ duplicate: true, lead: existingLead }));
  const res = response();
  await controller.createLead(request('admin'), res);
  assert.equal(res.code, 409);
  assert.equal(res.data.error, NEW_MSG);
  assert.equal(res.data.code, 'DUPLICATE_LEAD');
  assert.equal(res.data.existing_id, 'lead-1');               // the mobile app already reads this field
  assert.deepEqual(JSON.parse(JSON.stringify(res.data.existing_lead)), { id: 'lead-1', lead_number: 'LD-00007', name: 'Priya Shah', phone: '+919876543210' });
  assert.equal(calls.length, 1);
});

test('manual creation asks ingestion to refuse duplicates and to compare the phone number only', async () => {
  const { controller, calls } = controllerWith(() => ({ duplicate: true, lead: existingLead }));
  await controller.createLead(request('admin', { email: 'someone@example.com' }), response());
  assert.equal(calls[0].options.rejectDuplicate, true);
  assert.equal(calls[0].options.phoneOnly, true);
  assert.equal(calls[0].tenantId, 't1');                      // always the caller's own workspace
});

test('staff are not told about leads that are not assigned to them', async () => {
  const { controller } = controllerWith(() => ({ duplicate: true, lead: existingLead }));
  let res = response();
  await controller.createLead(request('staff'), res);
  assert.equal(res.code, 409);                                // still refused…
  assert.equal(res.data.error, NEW_MSG);
  assert.equal('existing_id' in res.data, false);             // …but no lead details leak
  assert.equal('existing_lead' in res.data, false);

  res = response();
  const { controller: own } = controllerWith(() => ({ duplicate: true, lead: { ...existingLead, assigned_to: 'user-1' } }));
  await own.createLead(request('staff'), res);                // staff user-1 owns this lead
  assert.equal(res.code, 409);
  assert.equal(res.data.existing_id, 'lead-1');
});

test('a genuinely new number is created normally', async () => {
  const created = { id: 'lead-2', name: 'Asha', phone: '+919811111111', assigned_to: null };
  const { controller } = controllerWith(() => ({ duplicate: false, lead: created }));
  const res = response();
  await controller.createLead(request('admin', { name: 'Asha', phone: '9811111111' }), res);
  assert.equal(res.code, 201);
  assert.equal(res.data.lead.id, 'lead-2');
});

test('missing name or phone is still a 400, and an invalid number is still a 422 (not a duplicate)', async () => {
  const { controller } = controllerWith(d => { quality.normalizeLead(d); return { duplicate: false, lead: {} }; });
  let res = response();
  await controller.createLead(request('admin', { phone: '' }), res);
  assert.equal(res.code, 400);
  res = response();
  await controller.createLead(request('admin', { phone: '12345' }), res);
  assert.equal(res.code, 422);
});

test('the live check reports a duplicate the moment a number is typed, using the phone only', async () => {
  const { controller, calls } = controllerWith(() => ({}), existingLead);
  const res = response();
  await controller.checkDuplicatePhone({ tenantId: 't1', user: { id: 'u', role: 'admin' }, query: { phone: '+91 98765 43210', email: 'ignored@example.com' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.data.duplicate, true);
  assert.equal(res.data.existing_id, 'lead-1');
  assert.equal(calls[0].lookup.phone, '+919876543210');        // normalised before comparing
  assert.equal(calls[0].lookup.tenantId, 't1');                // only the caller's workspace
});

test('the live check says "not a duplicate" for a new number, and stays quiet about invalid ones', async () => {
  const { controller } = controllerWith(() => ({}), undefined);
  let res = response();
  await controller.checkDuplicatePhone({ tenantId: 't1', user: { id: 'u', role: 'admin' }, query: { phone: '9811111111' } }, res);
  assert.equal(res.data.duplicate, false);
  res = response();
  await controller.checkDuplicatePhone({ tenantId: 't1', user: { id: 'u', role: 'admin' }, query: { phone: '123' } }, res);
  assert.equal(res.code, 422);                                  // the form's own phone validation handles this
});

test('the live check hides lead details from staff who do not own the lead', async () => {
  const { controller } = controllerWith(() => ({}), existingLead);
  const res = response();
  await controller.checkDuplicatePhone({ tenantId: 't1', user: { id: 'user-1', role: 'staff' }, query: { phone: '9876543210' } }, res);
  assert.equal(res.data.duplicate, true);
  assert.equal('existing_id' in res.data, false);
  assert.equal('existing_lead' in res.data, false);
});

test('every common way of writing the same Indian number normalises to one value', () => {
  for (const v of ['9876543210', '+91 9876543210', '+91-98765-43210', '919876543210', '09876543210', '(+91) 98765 43210']) {
    assert.equal(quality.normalizePhone(v), '+919876543210', v);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Real-database check (opt-in, like the other SQL tests). Uses the backend's own database through the real
// ingestion code, with a throw-away workspace that is always removed afterwards:
//   DUPLICATE_TEST_DATABASE=1 node --test tests/duplicateLead.test.js
test('real SQL: duplicates are caught by phone in any format, per workspace, never by email, and under concurrency', { skip: !process.env.DUPLICATE_TEST_DATABASE }, async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { query } = require('../config/db');
  const { ingestLead, findLeadByPhone } = require('../services/leadIngestion');
  const stamp = Date.now();
  const tenants = [];
  const mkTenant = async (label, settings = {}) => {
    const r = await query(`INSERT INTO tenants (name, slug, email, business_type, subscription_status, settings) VALUES ($1,$2,$3,'lead_management','active',$4) RETURNING id`,
      [`ZZ Dup ${label} ${stamp}`, `zz-dup-${label}-${stamp}`, `zz.dup.${label}.${stamp}@example.test`, JSON.stringify(settings)]);
    tenants.push(r.rows[0].id);
    return r.rows[0].id;
  };
  const count = async (tid) => +(await query('SELECT COUNT(*) n FROM leads WHERE tenant_id=$1', [tid])).rows[0].n;
  const manual = { rejectDuplicate: true, phoneOnly: true };
  try {
    const a = await mkTenant('a');
    const b = await mkTenant('b');

    // new number -> created
    const first = await ingestLead(a, { name: 'Priya', phone: '9876543210', source: 'manual' }, manual);
    assert.equal(first.duplicate, false);
    assert.equal(await count(a), 1);

    // the same number in every format -> refused, nothing inserted, existing lead returned
    for (const v of ['+91 9876543210', '+91-98765-43210', '919876543210', '09876543210', '(+91) 98765 43210']) {
      const again = await ingestLead(a, { name: 'Someone Else', phone: v, source: 'manual' }, manual);
      assert.equal(again.duplicate, true, v);
      assert.equal(again.lead.id, first.lead.id, v);
    }
    assert.equal(await count(a), 1);
    // a refused manual attempt leaves no trace on the existing lead
    assert.equal(+(await query(`SELECT COUNT(*) n FROM lead_activities WHERE lead_id=$1 AND activity_type='duplicate'`, [first.lead.id])).rows[0].n, 0);

    // the read-only lookup used by the live check finds it in any format, and only in its own workspace
    assert.equal((await findLeadByPhone({ query }, a, '+919876543210', 'IN')).id, first.lead.id);
    assert.equal(await findLeadByPhone({ query }, b, '+919876543210', 'IN'), undefined);
    assert.equal(await findLeadByPhone({ query }, a, '+919800000000', 'IN'), undefined);

    // a different number -> created
    const other = await ingestLead(a, { name: 'Asha', phone: '9811111111', source: 'manual' }, manual);
    assert.equal(other.duplicate, false);
    assert.equal(await count(a), 2);

    // another workspace may hold the same number (and never sees this one)
    const crossTenant = await ingestLead(b, { name: 'Priya', phone: '9876543210', source: 'manual' }, manual);
    assert.equal(crossTenant.duplicate, false);
    assert.notEqual(crossTenant.lead.id, first.lead.id);

    // a lead stored in an old, non-E.164 format is still found
    await query(`INSERT INTO leads (tenant_id, lead_number, name, phone, source, stage) VALUES ($1, 'LD-LEGACY', 'Legacy', '9822222222', 'manual', 'new')`, [a]);
    const legacy = await ingestLead(a, { name: 'Legacy again', phone: '+91 98222 22222', source: 'manual' }, manual);
    assert.equal(legacy.duplicate, true);

    // email is NEVER a reason to refuse — even in a workspace set to also match email
    const emailTenant = await mkTenant('email', { dedupe_mode: 'phone_or_email' });
    await ingestLead(emailTenant, { name: 'First', phone: '9833333333', email: 'same@example.com', source: 'manual' }, manual);
    const sameEmail = await ingestLead(emailTenant, { name: 'Second', phone: '9844444444', email: 'same@example.com', source: 'manual' }, manual);
    assert.equal(sameEmail.duplicate, false);
    assert.equal(await count(emailTenant), 2);

    // concurrent requests for one new number: exactly one is created
    const racers = await Promise.all(Array.from({ length: 6 }, () => ingestLead(a, { name: 'Race', phone: '9855555555', source: 'manual' }, manual)));
    assert.equal(racers.filter(r => !r.duplicate).length, 1);
    assert.equal(new Set(racers.map(r => r.lead.id)).size, 1);
    assert.equal(await count(a), 4);

    // a workspace that turned duplicate checking off keeps working as before
    const off = await mkTenant('off', { dedupe_mode: 'off' });
    await ingestLead(off, { name: 'One', phone: '9866666666', source: 'manual' }, manual);
    const allowed = await ingestLead(off, { name: 'Two', phone: '9866666666', source: 'manual' }, manual);
    assert.equal(allowed.duplicate, false);

    // webhooks / imports (no options) still merge instead of refusing, and record the duplicate
    const viaWebhook = await ingestLead(a, { name: 'Webhook', phone: '9876543210', source: 'meta_ads' });
    assert.equal(viaWebhook.duplicate, true);
    assert.equal(await count(a), 4);
    assert.equal(+(await query(`SELECT COUNT(*) n FROM lead_activities WHERE lead_id=$1 AND activity_type='duplicate'`, [first.lead.id])).rows[0].n, 1);
  } finally {
    for (const id of tenants) {
      for (const table of ['lead_activities', 'lead_submissions', 'leads']) await query(`DELETE FROM ${table} WHERE tenant_id=$1`, [id]).catch(() => {});
      await query('DELETE FROM tenants WHERE id=$1', [id]);
    }
  }
});
