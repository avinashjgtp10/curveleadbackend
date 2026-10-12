// Milestone events against REAL PostgreSQL, in a throwaway schema of a throwaway test database.
// SKIPPED unless PHASE1_TEST_DATABASE_URL names a database called curvelead_test_*. Run it with
// scripts/runPhase1SqlTests.js, which creates and drops that database for you.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const url = process.env.PHASE1_TEST_DATABASE_URL;
const skip = !url && 'set PHASE1_TEST_DATABASE_URL (a throwaway curvelead_test_* database) to run';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('milestone events: idempotent first-Won, suppressed entry stage, propagating errors, backfill, merges', { skip }, async () => {
  if (!/\/curvelead_test_[a-z0-9_]+(\?.*)?$/.test(url)) throw new Error('PHASE1_TEST_DATABASE_URL must point at a database named curvelead_test_*');
  const { Client } = require('pg');
  const schema = 'p1m_' + Date.now();
  const connect = async () => { const c = new Client({ connectionString: url }); await c.connect(); await c.query(`SET search_path TO ${schema}; SET timezone='UTC'`); return c; };
  const admin = new Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const c = await connect(); const c2 = await connect();
  const q = (s, p) => c.query(s, p);
  const T = '11111111-1111-1111-1111-111111111111';
  const backfill = require('../scripts/backfillMilestones');
  try {
    await q(`CREATE TABLE tenants(id uuid PRIMARY KEY);
      CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, stage text, won_at timestamp, updated_at timestamp DEFAULT now(), merged_into_id uuid);
      CREATE TABLE lead_stages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, pos int, is_won boolean DEFAULT false, is_lost boolean DEFAULT false, is_qualified boolean DEFAULT false, is_active boolean DEFAULT true);
      CREATE TABLE lead_stage_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, prev_stage text, new_stage text, changed_at timestamp DEFAULT now());`);
    await q('INSERT INTO tenants(id) VALUES($1)', [T]);
    for (const [n, pos, won, lost, qual] of [['New', 1, false, false, false], ['Qualified', 2, false, false, true], ['Won', 3, true, false, false], ['Converted', 4, true, false, false], ['Lost', 5, false, true, false], ['Poison', 6, true, false, false]]) {
      await q('INSERT INTO lead_stages(tenant_id,name,pos,is_won,is_lost,is_qualified) VALUES($1,$2,$3,$4,$5,$6)', [T, n, pos, won, lost, qual]);
    }
    await q(read('models/migration_phase1_milestones.sql'));
    await q(read('models/migration_phase1_milestones.sql')); // idempotent: runs twice

    const lead = async (stage = 'New') => (await q('INSERT INTO leads(tenant_id, stage) VALUES($1,$2) RETURNING id', [T, stage])).rows[0].id;
    const events = async (id) => (await q('SELECT milestone, suppressed, source FROM lead_milestone_events WHERE lead_id = $1 ORDER BY milestone, suppressed', [id])).rows.map((r) => `${r.milestone}${r.suppressed ? ':suppressed' : ''}${r.source === 'backfill' ? ':backfill' : ''}`);
    const move = (id, stage, client = c) => client.query('UPDATE leads SET stage = $2 WHERE id = $1', [id, stage]);

    // 1. a normal journey creates each milestone once, as the lead really reaches it
    const a = await lead('New');
    assert.deepEqual(await events(a), [], 'a new lead in a plain stage has no milestones');
    await move(a, 'Qualified'); assert.deepEqual(await events(a), ['qualified']);
    await move(a, 'Won'); assert.deepEqual(await events(a), ['qualified', 'won'], 'won implies qualified; qualified is not duplicated');

    // 2. repeats never make a second customer
    await move(a, 'Converted'); await move(a, 'Lost'); await move(a, 'Won'); await move(a, 'Qualified'); await move(a, 'Won');
    assert.deepEqual(await events(a), ['qualified', 'won'], 'Won -> Converted -> Lost -> Won ... is still one customer');

    // 3. an edit that resends the same stage, or only changes case/spacing, creates nothing and does not fail
    const b = await lead('Qualified');
    const before = (await events(b)).length;
    await move(b, 'Qualified'); await move(b, 'qualified'); await move(b, '  Qualified ');
    assert.equal((await events(b)).length, before);

    // 4. a lead CREATED in a won stage is suppressed (audit only); a real later Won still counts once
    const imported = await lead('Won');
    assert.deepEqual(await events(imported), ['qualified:suppressed', 'won:suppressed']);
    await move(imported, 'Lost'); await move(imported, 'Won');
    assert.deepEqual(await events(imported), ['qualified', 'qualified:suppressed', 'won', 'won:suppressed']);

    // 5. a stage the workspace does not know creates nothing and does not fail
    const odd = await lead('New'); await move(odd, 'Some old stage'); assert.deepEqual(await events(odd), []);

    // 6. merges: the transaction-local flag stops event creation, and it resets afterwards
    const m1 = await lead('New'); const m2 = await lead('New');
    await q('BEGIN'); await q(`SELECT set_config('curvelead.skip_milestones', 'on', true)`); await move(m1, 'Won'); await q('COMMIT');
    assert.deepEqual(await events(m1), [], 'no event while the merge flag is on');
    await move(m2, 'Won'); assert.deepEqual(await events(m2), ['qualified', 'won'], 'the flag does not leak to the next transaction');

    // 7. a recording failure is NEVER swallowed: the stage change fails and rolls back
    await q(`ALTER TABLE lead_milestone_events ADD CONSTRAINT poison CHECK (stage_name IS DISTINCT FROM 'Poison')`);
    const p = await lead('New');
    await assert.rejects(move(p, 'Poison'), /poison|check constraint/i);
    assert.equal((await q('SELECT stage FROM leads WHERE id = $1', [p])).rows[0].stage, 'New', 'the stage did not change');
    assert.deepEqual(await events(p), []);
    await q('ALTER TABLE lead_milestone_events DROP CONSTRAINT poison');

    // 8. concurrent transitions into different won stages still make exactly one customer
    const race = await lead('New');
    await Promise.all([move(race, 'Won', c), move(race, 'Converted', c2)]);
    assert.deepEqual(await events(race), ['qualified', 'won']);
    const racers = await Promise.all(Array.from({ length: 6 }, async () => lead('New')));
    await Promise.all(racers.map((id, i) => move(id, i % 2 ? 'Won' : 'Converted', i % 2 ? c : c2)));
    for (const id of racers) assert.deepEqual(await events(id), ['qualified', 'won']);

    // 9. backfill: leads that were won BEFORE the trigger existed
    await q('ALTER TABLE leads DISABLE TRIGGER lead_milestones_trigger');
    const old1 = await lead('Won'); const old2 = await lead('Qualified'); const absorbed = await lead('Won');
    await q(`UPDATE leads SET merged_into_id = $2 WHERE id = $1`, [absorbed, old1]);
    await q(`INSERT INTO lead_stage_history(tenant_id, lead_id, prev_stage, new_stage, changed_at) VALUES ($1,$2,'New','Qualified','2026-01-05 10:00'), ($1,$2,'Qualified','Won','2026-01-09 12:00'), ($1,$2,'Won','Lost','2026-02-01 09:00'), ($1,$2,'Lost','Won','2026-03-01 09:00')`, [T, old1]);
    await q(`UPDATE leads SET won_at = '2026-03-01 09:00' WHERE id = $1`, [old1]);
    await assert.rejects(backfill.run({ client: c, apply: true }), /trigger is not installed and enabled/, 'refuses while the trigger is disabled');
    await q('ALTER TABLE leads ENABLE TRIGGER lead_milestones_trigger');
    const dry = await backfill.run({ client: c, batch: 2 });
    assert.ok(dry.won.would_add >= 1 && dry.won.added === 0);
    assert.deepEqual(await events(old1), [], 'a dry run writes nothing');
    const applied = await backfill.run({ client: c, apply: true, batch: 2 });
    assert.ok(applied.won.added >= 1);
    assert.deepEqual(await events(old1), ['qualified:backfill', 'won:backfill']);
    const when = (await q(`SELECT milestone, to_char(occurred_at, 'YYYY-MM-DD HH24:MI') AS at FROM lead_milestone_events WHERE lead_id = $1 ORDER BY milestone`, [old1])).rows;
    assert.deepEqual(when, [{ milestone: 'qualified', at: '2026-01-05 10:00' }, { milestone: 'won', at: '2026-01-09 12:00' }], 'FIRST entry into each stage, from history');
    assert.deepEqual(await events(old2), ['qualified:backfill']);
    assert.deepEqual(await events(absorbed), [], 'absorbed (merged) leads are skipped');
    assert.deepEqual(await events(a), ['qualified', 'won'], 'a live event always wins over a backfill');
    const again = await backfill.run({ client: c, apply: true, batch: 2 });
    assert.equal(again.won.added + again.qualified.added, 0, 'a rerun adds nothing');

    // 10. the migration does not touch existing data or other tables
    assert.equal((await q(`SELECT count(*)::int n FROM leads`)).rows[0].n > 10, true);
  } finally {
    await c.end().catch(() => {}); await c2.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
