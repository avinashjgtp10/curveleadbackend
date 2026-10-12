// The throwaway-database harness can only ever point at a maintenance database and a curvelead_test_phase1_* name.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('../scripts/runPhase1SqlTests');

const ADMIN = 'postgres://postgres:p%40ss%2Fword@db.example.rds.amazonaws.com:5432/postgres?sslmode=no-verify';

test('only a maintenance database is accepted as the admin URL; an application database name is refused', () => {
  assert.doesNotThrow(() => h.assertAdminUrl(ADMIN));
  assert.doesNotThrow(() => h.assertAdminUrl('postgres://u@h/template1'));
  for (const bad of ['postgres://u@h/curvelead', 'postgres://u@h/production', 'postgres://u@h/', 'postgres://u@h', 'mysql://u@h/postgres', 'not a url']) {
    assert.throws(() => h.assertAdminUrl(bad), /Refusing|not a valid|must start/, bad);
  }
});

test('the test URL keeps host, user, password and options and swaps only the database name', () => {
  const name = h.testDbName(1700000000000);
  assert.equal(name, 'curvelead_test_phase1_1700000000000');
  const u = new URL(h.buildTestUrl(ADMIN, name));
  assert.equal(u.hostname, 'db.example.rds.amazonaws.com'); assert.equal(u.port, '5432');
  assert.equal(decodeURIComponent(u.password), 'p@ss/word'); assert.equal(u.pathname, `/${name}`); assert.equal(u.searchParams.get('sslmode'), 'no-verify');
  assert.throws(() => h.buildTestUrl(ADMIN, 'curvelead'), /bad test database name/);
  assert.throws(() => h.buildTestUrl(ADMIN, 'curvelead_test_phase1_1; DROP DATABASE x'), /bad test database name/);
  assert.throws(() => h.buildTestUrl('postgres://u@h/curvelead', name), /Refusing/);
});

test('test processes get a minimal environment with DB_* pinned to the throwaway database', () => {
  const env = h.childEnv(h.buildTestUrl(ADMIN, 'curvelead_test_phase1_1'));
  assert.equal(env.DB_NAME, 'curvelead_test_phase1_1'); assert.equal(env.DB_HOST, 'db.example.rds.amazonaws.com');
  assert.equal(env.DB_PASSWORD, 'p@ss/word'); assert.equal(env.DB_SSL, 'true');
  assert.deepEqual(Object.keys(env).sort(), ['DB_HOST', 'DB_NAME', 'DB_PASSWORD', 'DB_PORT', 'DB_SSL', 'DB_USER', 'HOME', 'PATH', 'PHASE1_TEST_DATABASE_URL']);
});

test('it only runs the phase1*Sql tests', () => {
  const files = h.testFiles();
  assert.ok(files.length >= 1 && files.every((f) => /^tests\/phase1.*Sql\.test\.js$/.test(f)));
  assert.ok(files.includes('tests/phase1MilestonesSql.test.js'));
  assert.ok(!files.includes('tests/phase1Sql.test.js'), 'the older phase1Sql.test.js needs a full production schema and is excluded');
});

test('the script refuses without authorization, without its own URL, and with an application database URL', () => {
  const cwd = path.join(__dirname, '..');
  const env = { PATH: process.env.PATH, DATABASE_URL: 'postgres://nope/curvelead' };
  let r = spawnSync(process.execPath, ['scripts/runPhase1SqlTests.js'], { env, cwd, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing/);
  r = spawnSync(process.execPath, ['scripts/runPhase1SqlTests.js', '--i-have-authorization'], { env, cwd, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /set PHASE1_ADMIN_URL/);
  r = spawnSync(process.execPath, ['scripts/runPhase1SqlTests.js', '--i-have-authorization'], { env: { ...env, PHASE1_ADMIN_URL: 'postgres://u:p@h.example/curvelead' }, cwd, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /maintenance database/);
});

test('the real-database tests refuse any database that is not named curvelead_test_*', () => {
  const src = require('fs').readFileSync(path.join(__dirname, 'phase1MilestonesSql.test.js'), 'utf8');
  assert.match(src, /curvelead_test_\[a-z0-9_\]\+/);
  assert.match(src, /skip = !url/);
});
