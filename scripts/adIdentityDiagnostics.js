#!/usr/bin/env node
// Runs db/phase1/ad_identity/00_diagnostics_readonly.sql inside a READ ONLY transaction.
// Refuses to run unless explicitly told which database it is allowed to touch:
//   AD_IDENTITY_DIAGNOSTICS_URL=postgres://...  node scripts/adIdentityDiagnostics.js --i-have-authorization
// Never reads DATABASE_URL on its own, so it cannot hit an environment by accident.
const fs = require('fs');
const path = require('path');

const SQL_FILE = path.join(__dirname, '..', 'db', 'phase1', 'ad_identity', '00_diagnostics_readonly.sql');

// Splits the file on "-- @@ name" markers and rejects anything that is not a SELECT/WITH.
const parseStatements = (sql) => {
  const out = [];
  for (const chunk of sql.split(/^-- @@ /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const name = chunk.slice(0, nl).trim();
    const body = chunk.slice(nl + 1).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim().replace(/;\s*$/, '');
    if (!/^(select|with)\b/i.test(body)) throw new Error(`Diagnostic "${name}" is not a SELECT`);
    if (/\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i.test(body.replace(/'[^']*'/g, ''))) throw new Error(`Diagnostic "${name}" contains a write keyword`);
    out.push({ name, sql: body });
  }
  return out;
};

const run = async ({ client, statements }) => {
  await client.query('BEGIN READ ONLY');
  const results = {};
  try {
    for (const s of statements) results[s.name] = (await client.query(s.sql)).rows;
  } finally {
    await client.query('ROLLBACK');
  }
  return results;
};

const main = async () => {
  if (!process.argv.includes('--i-have-authorization')) { console.error('Refusing: pass --i-have-authorization once a database has been approved for diagnostics.'); process.exit(2); }
  const url = process.env.AD_IDENTITY_DIAGNOSTICS_URL;
  if (!url) { console.error('Refusing: set AD_IDENTITY_DIAGNOSTICS_URL (this script ignores DATABASE_URL).'); process.exit(2); }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try { console.log(JSON.stringify(await run({ client, statements: parseStatements(fs.readFileSync(SQL_FILE, 'utf8')) }), null, 2)); }
  finally { await client.end(); }
};

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { parseStatements, run, SQL_FILE };
