const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildTimeline } = require('../utils/automationTimeline');

const at = (m) => new Date(Date.UTC(2026, 0, 1, 10, m)).toISOString();
test('the timeline lists only stored events, in order, with what is happening now', () => {
  const enrollments = [{ id: 'e1', sequence_id: 's1', sequence_name: 'Welcome', rule_name: 'New lead', trigger_type: 'new_lead', status: 'failed', current_step: 1, enrolled_at: at(0), next_send_at: at(60), blocked_reason: null, last_error: 'Template missing' }];
  const attempts = [
    { enrollment_id: 'e1', step_order: 1, status: 'failed', error: 'Template missing', updated_at: at(30), attempts: 1 },
    { enrollment_id: 'e1', step_order: 0, status: 'sent', updated_at: at(1), message_status: 'read' },
    { enrollment_id: 'gone', step_order: 0, status: 'sent', updated_at: at(2) },
  ];
  const { events, current } = buildTimeline({ enrollments, attempts, steps: { s1: [{ channel: 'whatsapp' }, { channel: 'email' }] }, replies: [{ enrollment_id: 'e1', classification: 'Yes', outcome: 'routed', created_at: at(10) }] });
  assert.deepEqual(events.map((e) => e.kind), ['enrolled', 'sent', 'reply', 'failed']);
  assert.equal(events[1].delivery, 'read'); assert.equal(events[1].step_number, 1);
  assert.equal(events[3].channel, 'email'); assert.equal(events[3].error, 'Template missing');
  assert.deepEqual(JSON.parse(JSON.stringify(current)), [{ enrollment_id: 'e1', sequence_id: 's1', sequence_name: 'Welcome', status: 'failed', next_step_number: 2, next_send_at: at(60), reason: 'Template missing' }]);
});
test('completed and stopped enrollments add one closing event and are not "current"', () => {
  const r = buildTimeline({ enrollments: [
    { id: 'a', sequence_id: 's', sequence_name: 'S', status: 'completed', enrolled_at: at(0), completed_at: at(5) },
    { id: 'b', sequence_id: 's', sequence_name: 'S', status: 'cancelled', enrolled_at: at(1), cancelled_at: at(6), cancelled_reason: 'opted_out' }] });
  assert.deepEqual(r.events.map((e) => e.kind), ['enrolled', 'enrolled', 'completed', 'stopped']);
  assert.equal(r.events[3].reason, 'opted_out'); assert.equal(r.current.length, 0);
});

function load(file, deps) { const m = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { module: m, exports: m.exports, console, parseInt, require: (n) => { if (n in deps) return deps[n]; throw new Error('Unmocked ' + n); } }); return m.exports; }
const url = process.env.AUTOMATION_TEST_DATABASE_URL;
test('timeline and analytics on real PostgreSQL', { skip: !url }, async (t) => {
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1'].includes(parsed.hostname) && /^\/curvelead_test_/.test(parsed.pathname), 'Only a local test database is permitted.');
  const { Pool, types } = require('pg'); types.setTypeParser(1114, (v) => new Date(v.replace(' ', 'T') + 'Z'));
  const pool = new Pool({ connectionString: url, max: 4, options: '-c timezone=UTC' });
  const schema = 'insights_' + Date.now(); await pool.query(`CREATE SCHEMA ${schema}`);
  const db = { query: async (sql, args) => { const c = await pool.connect(); try { await c.query(`SET search_path TO ${schema},public`); return await c.query(sql, args); } finally { c.release(); } } };
  t.after(async () => { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); });
  await db.query(fs.readFileSync(path.join(__dirname, 'fixtures/automationV5.sql'), 'utf8'));
  await db.query(fs.readFileSync(path.join(__dirname, '../models/migration_lead_automation_v5.sql'), 'utf8'));
  await db.query('ALTER TABLE leads ADD COLUMN assigned_to UUID');
  const ctrl = load('controllers/automationInsightsController.js', { '../config/db': db, '../utils/automationTimeline': { buildTimeline } });
  const call = async (fn, req) => { const out = {}; await fn({ tenantId: tenant, user: { role: 'admin' }, params: {}, query: {}, ...req }, { status(c) { out.code = c; return this; }, json(b) { out.body = b; } }); return out; };

  const q = async (sql, a) => (await db.query(sql, a)).rows[0];
  const tenant = (await q("INSERT INTO tenants(name) VALUES('t') RETURNING id")).id;
  const lead = async (name, extra = '') => (await q(`INSERT INTO leads(tenant_id,name,phone,whatsapp_opt_in_at,opted_out) VALUES($1,$2,'1',${extra || 'NULL,false'}) RETURNING id`, [tenant, name])).id;
  const asha = await lead('Asha', "now(),false"), ben = await lead('Ben'), cara = await lead('Cara', "now(),true");
  const seq = (await q("INSERT INTO automation_sequences(tenant_id,name) VALUES($1,'Welcome') RETURNING id", [tenant])).id;
  for (const [i, ch] of [[0, 'whatsapp'], [1, 'whatsapp']]) await db.query("INSERT INTO automation_sequence_steps(tenant_id,sequence_id,step_order,channel,message) VALUES($1,$2,$3,$4,'m')", [tenant, seq, i, ch]);
  const enroll = async (leadId, status, extra = {}) => (await q(`INSERT INTO automation_enrollments(tenant_id,lead_id,sequence_id,status,current_step) VALUES($1,$2,$3,$4,$5) RETURNING id`, [tenant, leadId, seq, status, extra.step || 0])).id;
  const eAsha = await enroll(asha, 'failed', { step: 1 }), eBen = await enroll(ben, 'blocked'), eCara = await enroll(cara, 'cancelled');
  await db.query("UPDATE automation_enrollments SET enrolled_at = now() - interval '3 hours' WHERE id=$1", [eAsha]);
  await db.query("UPDATE automation_enrollments SET last_error='[131049] not delivered' WHERE id=$1", [eAsha]);
  await db.query("UPDATE automation_enrollments SET blocked_reason='blocked_no_opt_in' WHERE id=$1", [eBen]);
  await db.query("UPDATE automation_enrollments SET cancelled_reason='opted_out', cancelled_at=now() WHERE id=$1", [eCara]);
  await db.query("INSERT INTO whatsapp_messages(tenant_id,lead_id,direction,message,status,wa_message_id,sent_at) VALUES($1,$2,'outbound','m','read','wamid.1', now() - interval '2 hours')", [tenant, asha]);
  await db.query("INSERT INTO whatsapp_messages(tenant_id,lead_id,direction,message,sent_at) VALUES($1,$2,'inbound','yes', now() - interval '1 hour')", [tenant, asha]);
  await db.query("INSERT INTO automation_send_attempts(tenant_id,enrollment_id,step_order,status,wa_message_id,updated_at) VALUES($1,$2,0,'sent','wamid.1', now() - interval '2 hours')", [tenant, eAsha]);
  await db.query("INSERT INTO automation_send_attempts(tenant_id,enrollment_id,step_order,status,error) VALUES($1,$2,1,'failed','[131049] not delivered')", [tenant, eAsha]);

  const tl = await call(ctrl.getLeadTimeline, { params: { leadId: asha } }); tl.body = JSON.parse(JSON.stringify(tl.body));
  assert.deepEqual(tl.body.events.map((e) => e.kind), ['enrolled', 'sent', 'failed']);
  assert.equal(tl.body.events.find((e) => e.kind === 'sent').delivery, 'read');
  assert.equal(tl.body.current[0].reason, '[131049] not delivered');
  assert.equal((await call(ctrl.getLeadTimeline, { params: { leadId: asha }, user: { role: 'staff', id: 'someone-else' } })).code, 404, 'staff only see leads assigned to them');
  assert.equal((await call(ctrl.getLeadTimeline, { params: { leadId: 'nope' } })).code, 422);

  const an = JSON.parse(JSON.stringify((await call(ctrl.getSequenceAnalytics, { params: { id: seq } })).body));
  assert.equal(an.enrolled.total, 3); assert.deepEqual(an.enrolled.by_status, { failed: 1, blocked: 1, cancelled: 1 });
  assert.deepEqual(an.stopped_because, [{ reason: 'opted_out', count: 1 }]);
  const [s1, s2] = an.steps;
  assert.deepEqual([s1.sent, s1.delivered, s1.read, s1.replied, s1.reply_rate], [1, 1, 1, 1, 100]);
  assert.deepEqual([s2.sent, s2.failed], [0, 1]);
  assert.deepEqual(an.failure_reasons, [{ code: '131049', detail: '[131049] not delivered', count: 1 }]);
  assert.deepEqual([an.opt_in.total, an.opt_in.opted_in, an.opt_in.opted_out, an.opt_in.held_for_opt_in, an.opt_in.coverage_rate], [3, 1, 1, 1, 33]);
  assert.deepEqual(an.problems.map((p) => [p.lead_name, p.status, p.reason]).sort(), [['Asha', 'failed', '[131049] not delivered'], ['Ben', 'blocked', 'blocked_no_opt_in']]);
  assert.equal((await call(ctrl.getSequenceAnalytics, { params: { id: '11111111-1111-1111-1111-111111111111' } })).code, 404);
  // other workspaces never see this sequence
  assert.equal((await call(ctrl.getSequenceAnalytics, { params: { id: seq }, tenantId: '11111111-1111-1111-1111-111111111111' })).code, 404);
});
