// Milestone backfill control flow (in-memory fake) and static guarantees of the migration.
// The real SQL runs in tests/phase1MilestonesSql.test.js against a throwaway PostgreSQL database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { run } = require('../scripts/backfillMilestones');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const fakeClient = ({ leads, triggerOn = true, failInsertAt = null }) => {
  const log = []; let inserts = 0; let inTxn = false;
  return { log, query: async (sql, params = []) => {
    log.push(sql.trim().split('\n')[0].slice(0, 50));
    if (/FROM pg_trigger/.test(sql)) return { rows: triggerOn ? [{ '?column?': 1 }] : [] };
    if (/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/.test(sql.trim())) { inTxn = /^BEGIN/.test(sql.trim()) ? true : /^(COMMIT|ROLLBACK)/.test(sql.trim()) ? false : inTxn; return { rows: [] }; }
    if (/ORDER BY id LIMIT/.test(sql)) {
      const [cursor, size] = params;
      return { rows: leads.filter((l) => cursor === null || l.id > cursor).slice(0, size) };
    }
    if (/SELECT count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: params[0].length }] };
    if (/^\s*INSERT INTO lead_milestone_events/.test(sql)) {
      assert.ok(inTxn, 'inserts happen inside a transaction'); inserts++;
      if (failInsertAt === inserts) throw new Error('connection lost');
      return { rowCount: params[0].length };
    }
    throw new Error(`unexpected SQL ${sql.slice(0, 60)}`);
  } };
};
const leads = (n) => Array.from({ length: n }, (_, i) => ({ id: id(i + 1) }));

test('walks every lead whatever the batch size and stops only when a scan finds nothing', async () => {
  for (const batch of [1, 3, 7, 500]) {
    const c = fakeClient({ leads: leads(10) });
    const r = await run({ client: c, apply: true, batch });
    assert.equal(r.scanned, 10, `batch=${batch}`);
    assert.equal(r.won.added, 10); assert.equal(r.qualified.added, 10);
  }
});

test('a dry run scans and counts but opens no transaction and inserts nothing', async () => {
  const c = fakeClient({ leads: leads(5), triggerOn: false });
  const r = await run({ client: c, batch: 2 });
  assert.equal(r.won.would_add, 5); assert.equal(r.won.added, 0);
  assert.ok(!c.log.some((l) => /^(BEGIN|INSERT|COMMIT)/.test(l)));
});

test('--apply is refused while the milestone trigger is missing or disabled', async () => {
  await assert.rejects(run({ client: fakeClient({ leads: leads(2), triggerOn: false }), apply: true }), /trigger is not installed and enabled/);
});

test('an interrupted batch rolls back alone and the report says what committed', async () => {
  const c = fakeClient({ leads: leads(6), failInsertAt: 3 }); // 2 inserts per batch: the 2nd batch fails on its first insert
  let err; try { await run({ client: c, apply: true, batch: 2 }); } catch (e) { err = e; }
  assert.match(err.message, /connection lost/);
  assert.equal(err.partialReport.batches, 1, 'only the first batch committed');
  assert.ok(c.log.includes('ROLLBACK'));
});

test('batch size is validated', async () => {
  for (const batch of [0, -1, 2.5, 'x', 6000]) await assert.rejects(run({ client: fakeClient({ leads: [] }), batch }), /batch must be/, String(batch));
});

test('the backfill inserts only, never updates or deletes, and a live event can never be overwritten', () => {
  const src = read('scripts/backfillMilestones.js');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /\b(UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
  assert.match(src, /ON CONFLICT DO NOTHING/);
  assert.match(src, /merged_into_id IS NULL/);
});

// ---- the migration -------------------------------------------------------------------------------------------------------
const sql = read('models/migration_phase1_milestones.sql');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('the trigger swallows nothing: no exception handler, so a recording failure fails the stage change', () => {
  assert.doesNotMatch(code, /\bEXCEPTION\b/i);
  assert.doesNotMatch(code, /WHEN OTHERS/i);
});

test('one live qualified and one live won event per lead is enforced by the database', () => {
  assert.match(code, /CREATE UNIQUE INDEX IF NOT EXISTS lead_milestone_live_uq ON lead_milestone_events \(lead_id, milestone\) WHERE NOT suppressed/);
  assert.match(code, /lead_milestone_suppressed_uq/);
});

test('the trigger acts only on a real stage change and honours the merge flag', () => {
  assert.match(code, /lower\(trim\(COALESCE\(NEW\.stage, ''\)\)\) = lower\(trim\(COALESCE\(OLD\.stage, ''\)\)\) THEN RETURN NEW/);
  assert.match(code, /current_setting\('curvelead\.skip_milestones', true\) = 'on'/);
  assert.match(code, /CREATE TRIGGER lead_milestones_trigger AFTER INSERT OR UPDATE OF stage ON leads/);
  assert.match(code, /is_suppressed := \(TG_OP = 'INSERT'\)/, 'a lead created in a won stage is suppressed');
});

test('the migration is additive: no ALTER/UPDATE/DELETE of existing tables, and the rollback is documented', () => {
  assert.doesNotMatch(code, /\b(ALTER TABLE|UPDATE\s+\w+\s+SET|DELETE FROM|DROP TABLE)\b/i);
  assert.match(sql, /-- ROLLBACK[\s\S]*DROP TRIGGER IF EXISTS lead_milestones_trigger/);
});

test('merges keep milestone events on their own lead and mute event creation for their transaction', () => {
  const merge = read('services/leadMerge.js');
  assert.match(merge, /cl\.relname NOT IN \('leads', 'lead_merges', 'lead_milestone_events'\)/);
  assert.match(merge, /set_config\('curvelead\.skip_milestones', 'on', true\)/);
});
