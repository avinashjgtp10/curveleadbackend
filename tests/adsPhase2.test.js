const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Phase 2: Lead Ads — signed webhook → queued job → one shared lead pipeline.

function load(file, deps = {}, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, Buffer, process: { env }, setTimeout, require: k => deps[k] || {} });
  return module.exports;
}
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; }, sendStatus(c) { this.code = c; return this; } });
const sign = (body, secret) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

const webhook = ({ knownPages = ['111'], env = { META_APP_SECRET: 'app-secret' } } = {}) => {
  const queued = [];
  const ctrl = load('controllers/metaWebhookController.js', {
    '../jobs/queues': { enqueue: async (name, data, opts) => { queued.push({ name, data, opts }); } },
    '../services/metaLeads': { tenantForPage: async (id) => (knownPages.includes(String(id)) ? 't1' : null) },
    '../utils/metaWebhookSignature': require('../utils/metaWebhookSignature'),
  }, env);
  return { ctrl, queued };
};

const payload = (entries) => ({ object: 'page', entry: entries.map(([pageId, leadIds]) => ({ id: pageId, changes: leadIds.map(id => ({ field: 'leadgen', value: { page_id: pageId, leadgen_id: id } })) })) });
const request = (body, signature) => { const raw = Buffer.from(JSON.stringify(body)); return { body, rawBody: raw, headers: signature === undefined ? {} : { 'x-hub-signature-256': signature(raw) } }; };

test('a correctly signed webhook queues every lead of every entry', async () => {
  const prev = process.env.META_APP_SECRET; process.env.META_APP_SECRET = 'app-secret';
  try {
    const { ctrl, queued } = webhook({ knownPages: [] });
    const r = res();
    await ctrl.receiveLeadFormWebhook(request(payload([['111', ['L1', 'L2']], ['222', ['L3']]]), raw => sign(raw, 'app-secret')), r);
    assert.equal(r.code, 200);
    assert.deepEqual(queued.map(q => q.data.leadgenId), ['L1', 'L2', 'L3']);
    assert.equal(queued[2].data.pageId, '222');
    assert.equal(queued[0].opts.jobId, 'meta-lead-L1');
  } finally { process.env.META_APP_SECRET = prev; }
});

test('tampered body, wrong secret or missing signature are rejected for unknown pages', async () => {
  const prev = process.env.META_APP_SECRET; process.env.META_APP_SECRET = 'app-secret';
  try {
    for (const [label, makeReq] of [
      ['tampered', () => { const q = request(payload([['999', ['L1']]]), raw => sign(raw, 'app-secret')); q.rawBody = Buffer.from(q.rawBody.toString().replace('L1', 'L9')); return q; }],
      ['wrong secret', () => request(payload([['999', ['L1']]]), raw => sign(raw, 'other-secret'))],
      ['missing header', () => request(payload([['999', ['L1']]]))],
    ]) {
      const { ctrl, queued } = webhook({ knownPages: [] });
      const r = res();
      await ctrl.receiveLeadFormWebhook(makeReq(), r);
      assert.equal(r.code, 401, label);
      assert.equal(queued.length, 0, label);
    }
  } finally { process.env.META_APP_SECRET = prev; }
});

test('unsigned deliveries for a connected page are accepted unless signatures are required', async () => {
  const prev = process.env.META_APP_SECRET; process.env.META_APP_SECRET = 'app-secret';
  try {
    let { ctrl, queued } = webhook({ knownPages: ['111'] });
    let r = res();
    await ctrl.receiveLeadFormWebhook(request(payload([['111', ['L1']]])), r);
    assert.equal(r.code, 200);
    assert.equal(queued.length, 1);

    ({ ctrl, queued } = webhook({ knownPages: ['111'], env: { META_WEBHOOK_REQUIRE_SIGNATURE: 'true' } }));
    r = res();
    await ctrl.receiveLeadFormWebhook(request(payload([['111', ['L1']]])), r);
    assert.equal(r.code, 401);
    assert.equal(queued.length, 0);
  } finally { process.env.META_APP_SECRET = prev; }
});

// ── shared pipeline ─────────────────────────────────────────────────────────
const pipeline = ({ known = [], scoreOnIngest = true } = {}) => {
  const calls = { ingest: [], welcome: 0, triggers: 0, scored: 0, assigned: 0 };
  const svc = load('services/metaLeads.js', {
    '../config/db': { query: async (sql, p) => {
      if (sql.includes('meta_lead_id = ANY')) return { rows: known.filter(k => p[1].includes(k)).map(k => ({ meta_lead_id: k })) };
      return { rows: [] };
    } },
    './leadIngestion': { ingestLead: async (tenantId, input) => { calls.ingest.push(input); return { lead: { id: `crm-${input.meta_lead_id}` }, duplicate: false }; } },
    '../utils/metaFieldData': { mapMetaFields: () => ({}), formatFieldDataNotes: () => 'notes' },
    '../utils/whatsappAutoResponder': { sendWelcomeMessage: async () => { calls.welcome++; } },
    '../utils/automationTriggers': { checkNewLeadTriggers: async () => { calls.triggers++; } },
    '../utils/leadAssignment': { applyAssignmentRules: async () => { calls.assigned++; } },
    '../utils/leadNotifyEmail': { notifyNewLead: async () => {} },
    '../controllers/notificationController': { notifyNewLeadToAdmins: async () => {} },
    '../utils/metaCampaignMatch': { findOrCreateMetaCampaign: async () => 'crm-campaign' },
    '../utils/deletedLeads': { isMetaLeadDeleted: async () => false },
    './leadScoring': { scoreAndSaveLead: async () => { calls.scored++; } },
    '../utils/metaGraph': {},
  });
  return { svc, calls, ctx: { tenantId: 't1', tenantName: 'Salonox', pageId: '111', pageToken: 'x', scoreOnIngest } };
};
const metaLead = (id, minutesAgo, extra = {}) => ({
  id, form_id: 'F1', ad_id: 'A1', adset_id: 'S1', campaign_id: 'C1', created_time: new Date(Date.now() - minutesAgo * 60000).toISOString(),
  field_data: [{ name: 'full_name', values: ['Priya'] }, { name: 'phone_number', values: ['+918980235151'] }], ...extra,
});

test('a fresh lead is created with its form id, scored, welcomed and enrolled', async () => {
  const { svc, calls, ctx } = pipeline();
  assert.equal(await svc.processMetaLead(ctx, metaLead('L1', 5)), 'created');
  assert.equal(calls.ingest[0].meta_form_id, 'F1');
  assert.equal(calls.ingest[0].campaign_id, 'crm-campaign');
  assert.equal(calls.ingest[0].meta_lead_id, 'L1');
  assert.equal(calls.scored, 1);
  assert.equal(calls.welcome, 1);
  assert.equal(calls.triggers, 1);
});

test('backfilled (old) leads are imported and scored but never messaged; scoring can be switched off', async () => {
  let { svc, calls, ctx } = pipeline();
  await svc.processMetaLead(ctx, metaLead('L1', 60 * 24 * 10));
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.welcome, 0);
  assert.equal(calls.triggers, 0);
  assert.equal(calls.assigned, 1);

  ({ svc, calls, ctx } = pipeline({ scoreOnIngest: false }));
  await svc.processMetaLead(ctx, metaLead('L2', 5));
  assert.equal(calls.scored, 0);
});

test('leads without a phone are skipped; leads already in the CRM are not re-ingested', async () => {
  const { svc, calls, ctx } = pipeline({ known: ['L1'] });
  const counts = await svc.processLeads(ctx, [metaLead('L1', 5), metaLead('L2', 5), metaLead('L3', 5, { field_data: [{ name: 'full_name', values: ['No phone'] }] })]);
  assert.deepEqual({ ...counts }, { created: 1, duplicate: 1, skipped: 1 });
  assert.deepEqual(calls.ingest.map(i => i.meta_lead_id), ['L2']);
});
