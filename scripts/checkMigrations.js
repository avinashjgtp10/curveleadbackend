// Which models/migration_*.sql files still need running? Read-only: nothing is changed.
//
//   node scripts/checkMigrations.js
//
// Each migration is checked by what it creates — tables (CREATE TABLE) and columns
// (ALTER TABLE … ADD COLUMN) — against information_schema. A file is PENDING when any of
// those is missing; files that only create indexes/functions/data can't be checked and
// are listed as UNKNOWN. Run the pending files in the order printed.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'models');

// Pure: the tables and columns one migration file creates.
const expectedObjects = (sql) => {
  const clean = sql.replace(/--[^\n]*/g, '');
  const tables = [...clean.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map(m => m[1].toLowerCase());
  const columns = [];
  for (const m of clean.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?(\w+)"?([\s\S]*?);/gi)) {
    for (const c of m[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)) columns.push([m[1].toLowerCase(), c[1].toLowerCase()]);
  }
  return { tables: [...new Set(tables)], columns };
};

async function run() {
  const { query, pool } = require('../config/db');
  try {
    // Oldest first, by when git first added each file (file mtimes change on every checkout).
    const added = (f) => {
      try { return Number(require('child_process').execSync(`git log --diff-filter=A --format=%ct -- "models/${f}"`, { cwd: path.join(__dirname, '..') }).toString().trim().split('\n').pop()) || Infinity; }
      catch { return Infinity; }
    };
    const files = fs.readdirSync(DIR).filter(f => /^migration_.*\.sql$/.test(f))
      .map(f => ({ f, at: added(f) })).sort((a, b) => a.at - b.at || a.f.localeCompare(b.f)).map(x => x.f);
    const tables = new Set((await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map(r => r.table_name));
    const cols = new Set((await query(`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`)).rows.map(r => r.c));
    const pending = [];
    for (const f of files) {
      const { tables: t, columns: c } = expectedObjects(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!t.length && !c.length) { console.log(`UNKNOWN  ${f} (no tables/columns to check)`); continue; }
      const missing = [...t.filter(x => !tables.has(x)), ...c.filter(([tb, cl]) => !cols.has(`${tb}.${cl}`)).map(([tb, cl]) => `${tb}.${cl}`)];
      if (missing.length) { pending.push(f); console.log(`PENDING  ${f} — missing ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` +${missing.length - 5} more` : ''}`); }
      else console.log(`ok       ${f}`);
    }
    console.log(`\n${pending.length} migration file(s) pending.${pending.length ? ' Run them in the order above, e.g.\n  psql "$DATABASE_URL" -f models/<file>.sql' : ''}`);
  } finally { await pool.end(); }
}

if (require.main === module) run().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { expectedObjects };
