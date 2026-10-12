#!/usr/bin/env node
// READ-ONLY report on stage / conversion accuracy for Phase 1 (see db/phase1/stage_integrity/00_diagnostics_readonly.sql).
//   STAGE_DIAGNOSTICS_URL=postgres://... node scripts/stageIntegrityDiagnostics.js --i-have-authorization > stage.json
// Runs inside one READ ONLY transaction. Every statement gets its own savepoint, so one statement that fails
// (for example a column that does not exist in this database) is reported by name and the rest still run.
// Ignores DATABASE_URL on purpose, so it cannot reach an environment by accident.
const fs = require('fs');
const path = require('path');
const { parseStatements } = require('./adIdentityDiagnostics');

const SQL_FILE = path.join(__dirname, '..', 'db', 'phase1', 'stage_integrity', '00_diagnostics_readonly.sql');

const run = async ({ client, statements }) => {
  await client.query('BEGIN READ ONLY');
  const results = {};
  try {
    await client.query(`SET LOCAL statement_timeout = '120s'`);
    for (const s of statements) {
      await client.query('SAVEPOINT stage_diag');
      try {
        results[s.name] = (await client.query(s.sql)).rows;
        await client.query('RELEASE SAVEPOINT stage_diag');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT stage_diag');
        results[s.name] = { error: e.message };
      }
    }
  } finally {
    await client.query('ROLLBACK');
  }
  return results;
};

const main = async () => {
  if (!process.argv.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization once a database has been approved for diagnostics.'); process.exit(2); }
  const url = process.env.STAGE_DIAGNOSTICS_URL;
  if (!url) { console.error('Refusing: set STAGE_DIAGNOSTICS_URL (this script ignores DATABASE_URL).'); process.exit(2); }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try { console.log(JSON.stringify(await run({ client, statements: parseStatements(fs.readFileSync(SQL_FILE, 'utf8')) }), null, 2)); }
  finally { await client.end(); }
};

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { run, SQL_FILE };
