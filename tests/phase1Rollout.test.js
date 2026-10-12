// The guided Phase 1 rollout script: dry-run by default, strict order, stops at the first problem, one workspace only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ro = require('../scripts/phase1Rollout');

const T = 'cbfeeb50-ff2c-4cea-b8b1-00d11070fb63';

const fakeClient = ({ present = {}, tenant = { id: T, name: 'Salonox', settings: {} }, failMigration = null } = {}) => {
  const log = []; const have = { lead_milestone_events: true, lead_payments: true, ...present };
  return { log, have, query: async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ').trim(); log.push(sql.slice(0, 60));
    if (/^SELECT to_regclass\(\$1\)/.test(sql)) return { rows: [{ ok: !!have[p[0]] }] };
    if (/^SELECT id, name, settings FROM tenants/.test(sql)) return { rows: tenant && p[0] === tenant.id ? [tenant] : [] };
    if (/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/.test(sql)) return { rows: [] };
    if (/^UPDATE tenants SET settings/.test(sql)) { log.push(`SHADOW:${p[0]}`); return { rows: [] }; }
    // a migration file: mark its object as present
    const m = /CREATE TABLE IF NOT EXISTS (lead_attribution|metric_shadow_log)\b|CREATE OR REPLACE VIEW (v_lead_booked)/.exec(sql);
    if (m) { if (failMigration && sql.includes(failMigration)) throw new Error('boom'); have[m[1] || m[2]] = true; log.push(`MIGRATED:${m[1] || m[2]}`); }
    return { rows: [] };
  } };
};
const okDeps = (calls) => ({
  backfillMilestones: async (a) => { calls.milestones = a; return { scanned: 3 }; },
  backfillAttribution: async (a) => { calls.attribution = a; return { scanned: 3 }; },
  migrateAdvances: async (a) => { calls.advances = a; return { migrated: 0 }; },
  getHealth: async () => ({ ok: true, checks: [] }),
});
const opts = (over = {}) => ({ tenantId: T, applySchema: false, applyBackfills: false, applyAdvances: false, shadow: false, batch: 500, ...over });
const root = path.join(__dirname, '..');

test('arguments: every apply is an explicit flag, nothing is on by default', () => {
  assert.deepEqual(ro.parseArgs(['--i-have-authorization', `--tenant=${T}`]), { authorized: true, tenantId: T, applySchema: false, applyBackfills: false, applyAdvances: false, shadow: false, batch: 500 });
  const all = ro.parseArgs(['--apply-schema', '--apply-backfills', '--apply-advances', '--shadow', '--batch=50', `--tenant=${T}`]);
  assert.deepEqual([all.applySchema, all.applyBackfills, all.applyAdvances, all.shadow, all.batch], [true, true, true, true, 50]);
});

test('the script refuses without authorization, its own URL, and a workspace', () => {
  const env = { PATH: process.env.PATH, DATABASE_URL: 'postgres://nope/x' };
  const run = (...a) => spawnSync(process.execPath, ['scripts/phase1Rollout.js', ...a], { env: { ...env, ...(a.url ? {} : {}) }, cwd: root, encoding: 'utf8' });
  let r = run(); assert.equal(r.status, 2); assert.match(r.stderr, /Refusing/);
  r = run('--i-have-authorization'); assert.equal(r.status, 2); assert.match(r.stderr, /set PHASE1_ROLLOUT_URL/);
  r = spawnSync(process.execPath, ['scripts/phase1Rollout.js', '--i-have-authorization'], { env: { ...env, PHASE1_ROLLOUT_URL: 'postgres://u@h/db' }, cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /--tenant=<workspace uuid>/);
  const src = fs.readFileSync(path.join(root, 'scripts/phase1Rollout.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /process\.env\.DATABASE_URL|dotenv/);
});

test('dry run with missing migrations reports them, applies nothing, and stops before any data step', async () => {
  const c = fakeClient(); const calls = {};
  const rep = await ro.rollout({ client: c, opts: opts(), root, deps: okDeps(calls) });
  assert.equal(rep.stopped.step, 'schema'); assert.match(rep.stopped.why, /dry run/);
  assert.ok(Object.values(rep.steps.schema).every((v) => v.startsWith('MISSING')));
  assert.ok(!c.log.some((l) => /^BEGIN|MIGRATED/.test(l)));
  assert.deepEqual(calls, {}, 'no backfill ran');
});

test('--apply-schema installs attribution, then booking, then reporting, each in its own transaction, skipping what exists', async () => {
  const c = fakeClient({ present: { lead_attribution: true } }); const calls = {};
  const rep = await ro.rollout({ client: c, opts: opts({ applySchema: true }), root, deps: okDeps(calls) });
  assert.equal(rep.stopped, null);
  assert.deepEqual(Object.values(rep.steps.schema), ['already applied', 'applied now', 'applied now']);
  assert.deepEqual(c.log.filter((l) => l.startsWith('MIGRATED')), ['MIGRATED:v_lead_booked', 'MIGRATED:metric_shadow_log']);
  assert.equal(c.log.filter((l) => l === 'BEGIN').length, 2); assert.equal(c.log.filter((l) => l === 'COMMIT').length, 2);
});

test('a failing migration is rolled back and the run stops there', async () => {
  const c = fakeClient({ failMigration: 'v_lead_booked' }); const calls = {};
  const rep = await ro.rollout({ client: c, opts: opts({ applySchema: true }), root, deps: okDeps(calls) });
  assert.equal(rep.stopped.step, 'schema'); assert.match(rep.stopped.why, /migration_phase1_booking\.sql failed and was rolled back: boom/);
  assert.ok(c.log.includes('ROLLBACK')); assert.deepEqual(calls, {});
});

test('missing prerequisites (milestones, ledger) stop the run before anything else', async () => {
  for (const missing of ['lead_milestone_events', 'lead_payments']) {
    const rep = await ro.rollout({ client: fakeClient({ present: { [missing]: false } }), opts: opts({ applySchema: true }), root, deps: okDeps({}) });
    assert.equal(rep.stopped.step, 'prerequisites'); assert.match(rep.stopped.why, new RegExp(missing));
  }
});

test('unknown workspace and a malformed id stop immediately', async () => {
  assert.match((await ro.rollout({ client: fakeClient(), opts: opts({ tenantId: 'nope' }), root, deps: okDeps({}) })).stopped.why, /workspace uuid/);
  assert.match((await ro.rollout({ client: fakeClient({ tenant: null }), opts: opts(), root, deps: okDeps({}) })).stopped.why, /No such workspace/);
});

test('backfills and advances are dry-run unless their own flag is given, and always limited to the one workspace', async () => {
  const ready = { lead_attribution: true, v_lead_booked: true, metric_shadow_log: true };
  let calls = {}; await ro.rollout({ client: fakeClient({ present: ready }), opts: opts(), root, deps: okDeps(calls) });
  assert.deepEqual([calls.milestones.apply, calls.attribution.apply, calls.advances.apply], [false, false, false]);
  assert.ok([calls.milestones, calls.attribution, calls.advances].every((a) => a.tenantId === T), 'every step is limited to the workspace');
  calls = {}; await ro.rollout({ client: fakeClient({ present: ready }), opts: opts({ applyBackfills: true }), root, deps: okDeps(calls) });
  assert.deepEqual([calls.milestones.apply, calls.attribution.apply, calls.advances.apply], [true, true, false], 'backfills apply; the advance migration still does not');
  calls = {}; await ro.rollout({ client: fakeClient({ present: ready }), opts: opts({ applyAdvances: true }), root, deps: okDeps(calls) });
  assert.deepEqual([calls.milestones.apply, calls.attribution.apply, calls.advances.apply], [false, false, true]);
});

test('shadow mode is switched on only when asked and only when the health report has no errors', async () => {
  const ready = { lead_attribution: true, v_lead_booked: true, metric_shadow_log: true };
  let c = fakeClient({ present: ready }); await ro.rollout({ client: c, opts: opts(), root, deps: okDeps({}) });
  assert.ok(!c.log.some((l) => l.startsWith('SHADOW')), 'not without --shadow');
  c = fakeClient({ present: ready }); const rep = await ro.rollout({ client: c, opts: opts({ shadow: true }), root, deps: okDeps({}) });
  assert.ok(c.log.includes(`SHADOW:${T}`)); assert.match(rep.steps.shadow, /shadow/);
  c = fakeClient({ present: ready }); const bad = await ro.rollout({ client: c, opts: opts({ shadow: true }), root, deps: { ...okDeps({}), getHealth: async () => ({ ok: false, checks: [{ id: 'entry_stage_flagged', ok: false }] }) } });
  assert.equal(bad.stopped.step, 'shadow'); assert.ok(!c.log.some((l) => l.startsWith('SHADOW')));
});

test('the milestone backfill can be limited to one workspace', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/backfillMilestones.js'), 'utf8');
  assert.match(src, /\(\$3::uuid IS NULL OR tenant_id = \$3::uuid\)/);
  assert.match(src, /client\.query\(BATCH, \[cursor, batch, tenantId\]\)/);
});
