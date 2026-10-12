// The stage / conversion diagnostics are strictly read-only, never select personal data, and one failing
// statement cannot hide the others. No database: a fake client records what is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { parseStatements } = require('../scripts/adIdentityDiagnostics');
const d = require('../scripts/stageIntegrityDiagnostics');

const statements = () => parseStatements(fs.readFileSync(d.SQL_FILE, 'utf8'));

test('every statement is a SELECT/WITH and none selects personal lead data', () => {
  const stmts = statements();
  assert.ok(stmts.length >= 10);
  for (const s of stmts) {
    assert.match(s.sql, /^(select|with)\b/i, s.name);
    assert.doesNotMatch(s.sql, /\b(phone|email|l\.name|notes|token|password|address|whatsapp)\b/i, `${s.name} must not select personal data`);
  }
  assert.deepEqual(stmts.map((s) => s.name).slice(0, 2), ['triggers_present', 'stage_config']);
});

test('the runner opens one READ ONLY transaction, uses a savepoint per statement and always rolls back', async () => {
  const seen = [];
  const client = { query: async (sql) => { seen.push(sql); return { rows: [] }; } };
  await d.run({ client, statements: statements() });
  assert.equal(seen[0], 'BEGIN READ ONLY');
  assert.equal(seen[seen.length - 1], 'ROLLBACK');
  assert.equal(seen.filter((s) => s === 'SAVEPOINT stage_diag').length, statements().length);
  const body = seen.filter((s) => !/^(BEGIN READ ONLY|ROLLBACK|SET LOCAL|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(s));
  assert.ok(body.every((s) => /^\s*(select|with)\b/i.test(s)), 'only SELECTs reach the database');
});

test('a statement that errors is reported by name and the remaining statements still run', async () => {
  const stmts = statements();
  let n = 0;
  const client = { query: async (sql) => {
    if (/^(BEGIN|SAVEPOINT|RELEASE|ROLLBACK|SET)/.test(sql)) return { rows: [] };
    n++;
    if (n === 2) throw new Error('column "is_qualified" does not exist');
    return { rows: [{ ok: n }] };
  } };
  const out = await d.run({ client, statements: stmts });
  assert.deepEqual(out[stmts[1].name], { error: 'column "is_qualified" does not exist' });
  assert.deepEqual(out[stmts[0].name], [{ ok: 1 }]);
  assert.deepEqual(out[stmts[2].name], [{ ok: 3 }]);
});

test('the script refuses to run without authorization and its own URL', () => {
  const { spawnSync } = require('child_process');
  const env = { ...process.env, DATABASE_URL: 'postgres://nope', DB_HOST: 'nope' }; delete env.STAGE_DIAGNOSTICS_URL;
  let r = spawnSync(process.execPath, ['scripts/stageIntegrityDiagnostics.js'], { env, encoding: 'utf8', cwd: require('path').join(__dirname, '..') });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing/);
  r = spawnSync(process.execPath, ['scripts/stageIntegrityDiagnostics.js', '--i-have-authorization'], { env, encoding: 'utf8', cwd: require('path').join(__dirname, '..') });
  assert.equal(r.status, 2); assert.match(r.stderr, /Refusing: set STAGE_DIAGNOSTICS_URL/);
});
