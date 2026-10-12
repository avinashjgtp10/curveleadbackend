#!/usr/bin/env node
// Runs the Phase 1 real-PostgreSQL tests (tests/phase1*Sql.test.js) against a THROWAWAY database that this script
// creates on the server you point it at, then drops. It never touches your application database.
//
//   PHASE1_ADMIN_URL='postgres://USER:PASSWORD@HOST:5432/postgres?sslmode=no-verify' \
//     node scripts/runPhase1SqlTests.js --i-have-authorization [--with-unit] [--keep]
//
// ONE SHOT: runs every real-database test (all Phase 1 files plus the ad-identity one) against the throwaway database, each file
// on its own, then prints one table and one verdict. --with-unit first runs the whole offline unit suite (no database).
// Exit code 0 only when every file passes and none was silently skipped.
//
// Safety
//  - The admin URL must end in a maintenance database (postgres / template1). A URL naming your application
//    database is refused, so the script cannot be aimed at it by mistake.
//  - The test database is always named curvelead_test_phase1_<timestamp>; the tests refuse any other name.
//  - Child processes get a minimal environment with DB_* pinned to the throwaway database, so nothing can fall
//    back to a .env file or to your application credentials.
//  - The database is dropped at the end, also when tests fail (unless --keep).
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const MAINTENANCE_DBS = ['postgres', 'template1'];
const dbOf = (u) => decodeURIComponent(new URL(u).pathname.replace(/^\//, ''));

const assertAdminUrl = (adminUrl) => {
  let u; try { u = new URL(adminUrl); } catch { throw new Error('PHASE1_ADMIN_URL is not a valid postgres URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('PHASE1_ADMIN_URL must start with postgres://');
  if (!MAINTENANCE_DBS.includes(dbOf(adminUrl))) throw new Error(`Refusing: the admin URL must name the maintenance database (${MAINTENANCE_DBS.join(' or ')}), not "${dbOf(adminUrl) || '(none)'}". Your application database is never used.`);
  return u;
};
const testDbName = (now = Date.now()) => `curvelead_test_phase1_${now}`;
const buildTestUrl = (adminUrl, dbName) => {
  assertAdminUrl(adminUrl);
  if (!/^curvelead_test_phase1_\d+$/.test(dbName)) throw new Error('bad test database name');
  const u = new URL(adminUrl); u.pathname = `/${dbName}`; return u.toString();
};
// A minimal environment for the test processes: only what node needs, plus DB_* pinned to the test database.
const childEnv = (testUrl) => {
  const u = new URL(testUrl);
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/tmp',
    PHASE1_TEST_DATABASE_URL: testUrl, ADS_TEST_DATABASE_URL: testUrl,
    DB_HOST: u.hostname, DB_PORT: u.port || '5432', DB_NAME: dbOf(testUrl), DB_USER: decodeURIComponent(u.username), DB_PASSWORD: decodeURIComponent(u.password),
    DB_SSL: u.searchParams.has('sslmode') && u.searchParams.get('sslmode') !== 'disable' ? 'true' : 'false',
  };
};
// phase1Sql.test.js is an older test that needs a full production schema; only the new phase1<Name>Sql tests run here.
const testFiles = () => [...fs.readdirSync(path.join(__dirname, '..', 'tests')).filter((f) => /^phase1.+Sql\.test\.js$/.test(f)).map((f) => `tests/${f}`).sort(), 'tests/adIdentitySql.test.js'];

// Counts from a node --test TAP report.
const parseTap = (text) => {
  const n = (k) => { const m = new RegExp(`^# ${k} (\\d+)`, 'm').exec(text); return m ? Number(m[1]) : 0; };
  return { tests: n('tests'), pass: n('pass'), fail: n('fail'), skipped: n('skipped') };
};
// Verdict: every file must have run, passed, and not have been skipped (a skip with a database provided means the test did not run).
const verdict = (results) => {
  const problems = [];
  for (const r of results) {
    if (r.status !== 0 || r.fail > 0) problems.push(`${r.file}: failing`);
    else if (r.pass === 0) problems.push(`${r.file}: nothing ran`);
    else if (r.skipped > 0) problems.push(`${r.file}: ${r.skipped} skipped`);
  }
  return { ok: problems.length === 0, problems };
};
const table = (results) => {
  const w = Math.max(...results.map((r) => r.file.length), 4);
  const lines = [`${'FILE'.padEnd(w)}  PASS  FAIL  SKIP`];
  for (const r of results) lines.push(`${r.file.padEnd(w)}  ${String(r.pass).padStart(4)}  ${String(r.fail).padStart(4)}  ${String(r.skipped).padStart(4)}  ${r.status === 0 && r.fail === 0 && r.pass > 0 && r.skipped === 0 ? 'ok' : 'FAILED'}`);
  return lines.join('\n');
};

const main = async () => {
  if (!process.argv.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization.'); process.exit(2); }
  const adminUrl = process.env.PHASE1_ADMIN_URL;
  if (!adminUrl) { console.error('Refusing: set PHASE1_ADMIN_URL (this script ignores DATABASE_URL and .env).'); process.exit(2); }
  try { assertAdminUrl(adminUrl); } catch (e) { console.error(e.message); process.exit(2); }

  const { Client } = require('pg');
  const name = testDbName();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let code = 1;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    console.error(`created throwaway database ${name}`);
    const testUrl = buildTestUrl(adminUrl, name);
    const cwd = path.join(__dirname, '..');
    let unitOk = true;
    if (process.argv.includes('--with-unit')) {
      console.error('running the offline unit suite…');
      const unitFiles = fs.readdirSync(path.join(cwd, 'tests')).filter((f) => /\.test\.js$/.test(f)).map((f) => `tests/${f}`);
      const u = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...unitFiles], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/tmp', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'none', DB_USER: 'none', DB_PASSWORD: '', DB_SSL: 'false' } });
      const c = parseTap(u.stdout || '');
      console.error(`unit suite: ${c.pass} pass, ${c.fail} fail, ${c.skipped} skipped (database tests skip here by design)`);
      if (u.status !== 0 || c.fail > 0) { unitOk = false; console.error((u.stdout || '').split('\n').filter((l) => /^not ok/.test(l)).slice(0, 20).join('\n')); }
    }
    const results = [];
    for (const file of testFiles()) {
      console.error(`running ${file}…`);
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd, env: childEnv(testUrl), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      results.push({ file, status: r.status, ...parseTap(r.stdout || '') });
      if (r.status !== 0) { // show why, trimmed: failing subtests and their error lines
        const out = (r.stdout || '').split('\n');
        const bad = out.map((l, i) => (/^\s*not ok/.test(l) ? out.slice(i, i + 14).join('\n') : null)).filter(Boolean).slice(0, 6);
        console.error(bad.join('\n---\n') || (r.stderr || '').slice(0, 2000));
      }
    }
    console.error('\n' + table(results));
    const v = verdict(results);
    if (!unitOk) v.problems.unshift('the offline unit suite has failures');
    console.error(v.ok && unitOk ? '\nRESULT: ALL PASS' : `\nRESULT: FAIL\n - ${v.problems.join('\n - ')}`);
    code = v.ok && unitOk ? 0 : 1;
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
  } finally {
    if (process.argv.includes('--keep')) console.error(`kept ${name} (drop it yourself when done)`);
    else {
      try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); console.error(`dropped ${name}`); }
      catch (e) { console.error(`COULD NOT DROP ${name}: ${e.message} -- drop it manually`); }
    }
    await admin.end();
  }
  process.exit(code);
};

if (require.main === module) main();
module.exports = { assertAdminUrl, testDbName, buildTestUrl, childEnv, testFiles, parseTap, verdict, table, MAINTENANCE_DBS };
