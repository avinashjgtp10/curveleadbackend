#!/usr/bin/env node
// Runs the Phase 1 real-PostgreSQL tests (tests/phase1*Sql.test.js) against a THROWAWAY database that this script
// creates on the server you point it at, then drops. It never touches your application database.
//
//   PHASE1_ADMIN_URL='postgres://USER:PASSWORD@HOST:5432/postgres?sslmode=no-verify' \
//     node scripts/runPhase1SqlTests.js --i-have-authorization [--keep]
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
    PHASE1_TEST_DATABASE_URL: testUrl,
    DB_HOST: u.hostname, DB_PORT: u.port || '5432', DB_NAME: dbOf(testUrl), DB_USER: decodeURIComponent(u.username), DB_PASSWORD: decodeURIComponent(u.password),
    DB_SSL: u.searchParams.has('sslmode') && u.searchParams.get('sslmode') !== 'disable' ? 'true' : 'false',
  };
};
const testFiles = () => fs.readdirSync(path.join(__dirname, '..', 'tests')).filter((f) => /^phase1.*Sql\.test\.js$/.test(f)).map((f) => `tests/${f}`).sort();

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
    const files = testFiles();
    console.error(`running: ${files.join(', ')}`);
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: path.join(__dirname, '..'), env: childEnv(testUrl), stdio: 'inherit' });
    code = r.status === 0 ? 0 : 1;
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
module.exports = { assertAdminUrl, testDbName, buildTestUrl, childEnv, testFiles, MAINTENANCE_DBS };
