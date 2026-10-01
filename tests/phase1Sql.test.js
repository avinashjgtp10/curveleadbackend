const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('automation SQL paginates over 500 leads, filters outcomes and isolates tenants/staff', { skip: !process.env.PHASE1_TEST_DATABASE_URL }, async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.PHASE1_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE leads (id uuid PRIMARY KEY, tenant_id text, assigned_to text, name text, phone text, won_at timestamp, lost_at timestamp, opted_out boolean);
      CREATE TEMP TABLE automation_sequences (id uuid PRIMARY KEY, name text);
      CREATE TEMP TABLE automation_sequence_steps (id uuid, sequence_id uuid, step_order int, channel text, message text);
      CREATE TEMP TABLE automation_enrollments (id uuid PRIMARY KEY, lead_id uuid, tenant_id text, sequence_id uuid, status text, current_step int, enrolled_at timestamp);
      INSERT INTO leads SELECT md5(i::text)::uuid, 'a', CASE WHEN i <= 550 THEN 'staff-a' ELSE 'staff-b' END, 'Lead ' || i, '9999999999', CASE WHEN i = 1 THEN NOW() END, CASE WHEN i = 2 THEN NOW() END, false FROM generate_series(1, 600) i;
      INSERT INTO leads VALUES(md5('foreign')::uuid, 'b', 'staff-a', 'Foreign', '', NULL, NULL, false);
      INSERT INTO automation_sequences VALUES(md5('seq')::uuid, 'Welcome');
      INSERT INTO automation_sequence_steps VALUES(md5('step')::uuid, md5('seq')::uuid, 0, 'whatsapp', 'Hi');
      INSERT INTO automation_enrollments SELECT md5(('e' || i)::text)::uuid, md5(i::text)::uuid, 'a', md5('seq')::uuid, 'active', 0, NOW() FROM generate_series(1, 3) i;`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers/automationEnrollmentController.js'), 'utf8'), { module, console, require: name => name === '../config/db' ? { query: (sql, params) => client.query(sql, params) } : {} });
    const run = async (query, role = 'staff') => {
      const res = { status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
      await module.exports.getAutomationLeads({ tenantId: 'a', user: { role, id: 'staff-a' }, query }, res);
      assert.equal(res.code, undefined); return res.data;
    };
    const first = await run({ page: 1, limit: 25 });
    assert.equal(first.leads.length, 25); assert.equal(first.total, 550);
    assert.deepEqual(first.summary, { total: 550, inProgress: 1, converted: 1, lost: 1 });
    assert.equal((await run({ page: 22, limit: 25 })).leads.length, 25);
    assert.equal((await run({ page: 23, limit: 25 })).leads.length, 0);
    const active = await run({ status: 'In Progress' });
    assert.equal(active.total, 1); assert.equal(active.leads[0].enrollment.steps.length, 1);
    assert.equal(active.leads[0].step, 'Step 1 of 1');
    assert.equal((await run({ step: 'Step 1 of 1' })).total, 3);
    assert.equal((await run({ search: 'Foreign' })).total, 0);
    assert.equal((await run({}, 'admin')).total, 600);
  } finally { await client.query('ROLLBACK'); await client.end(); }
});

test('legacy billing schema works and critical migration can run twice', { skip: !process.env.PHASE1_TEST_DATABASE_URL }, async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.PHASE1_TEST_DATABASE_URL });
  await client.connect();
  const schema = `phase1_${process.pid}`;
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}, public;
      CREATE TABLE tenants (id uuid PRIMARY KEY);
      CREATE TABLE lead_activities (id uuid PRIMARY KEY);
      CREATE TABLE plans (id uuid, name text, price numeric, max_leads int, max_staff int, is_active boolean);
      INSERT INTO plans VALUES(uuid_generate_v4(), 'Starter', 999, 100, 7, true);`);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers/paymentController.js'), 'utf8'), { module, process: { env: {} }, console, require: name => name === '../config/db' ? { query: (sql, params) => client.query(sql, params) } : {} });
    let payload;
    const response = { json(data) { payload = data; }, status() { throw new Error('Billing query failed'); } };
    await module.exports.getPlans({}, response);
    assert.equal(payload.plans[0].max_users, 7);
    await client.query('ALTER TABLE plans ADD COLUMN max_users int DEFAULT 5');
    await module.exports.getPlans({}, response);
    assert.equal(payload.plans[0].max_users, 5);
    const migration = fs.readFileSync(path.join(__dirname, '../models/migration_phase1_critical.sql'), 'utf8');
    await client.query(migration); await client.query(migration);
    assert.equal((await client.query('SELECT * FROM sales_playbooks')).rowCount, 0);
    await client.query("INSERT INTO lead_activities(id, metadata) VALUES(uuid_generate_v4(), '{\"scheduled_at\":\"2026-10-07T13:30:00Z\"}')");
  } finally {
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
