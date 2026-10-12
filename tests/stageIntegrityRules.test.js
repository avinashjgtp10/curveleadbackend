// Phase 1 stage integrity: renames, deletes and deactivations must not silently orphan leads or history
// (conversion numbers match stages by name). Refusals explain themselves; existing data is never rewritten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- a fake database for the stage rules ------------------------------------------------------------------------------------
const fakeDb = ({ stages, leadsByStage = {}, historyByStage = {} }) => {
  const writes = [];
  const count = (map, name) => map[String(name).trim().toLowerCase()] || 0;
  const query = async (sql, p = []) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql.trim().slice(0, 40));
    if (/SELECT \(SELECT count\(\*\)::int FROM leads/.test(sql)) return { rows: [{ leads: count(leadsByStage, p[1]), history: count(historyByStage, p[1]) }] };
    if (/FROM lead_stages WHERE tenant_id = \$1 AND lower\(trim\(name\)\)/.test(sql)) {
      const hit = stages.find((s) => s.name.trim().toLowerCase() === String(p[1]).trim().toLowerCase() && s.id !== p[2]);
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (/SELECT count\(\*\)::int AS n FROM lead_stages WHERE tenant_id = \$1 AND id <> \$2 AND is_won/.test(sql)) {
      return { rows: [{ n: stages.filter((s) => s.id !== p[1] && s.is_won && s.is_active !== false).length }] };
    }
    if (/SELECT id, name, is_won, is_lost, COALESCE\(is_active, true\)/.test(sql)) {
      const s = stages.find((x) => x.id === p[0]); return { rows: s ? [{ ...s, is_active: s.is_active !== false }] : [] };
    }
    if (/SELECT s\.is_won, s\.is_lost,/.test(sql)) { const s = stages.find((x) => x.id === p[0]); return { rows: s ? [{ is_won: s.is_won, is_lost: s.is_lost, is_first: s.id === stages[0].id }] : [] }; }
    if (/SELECT name, is_won FROM lead_stages WHERE id/.test(sql)) { const s = stages.find((x) => x.id === p[0]); return { rows: s ? [s] : [] }; }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
  return { query, writes };
};
const load = (db) => {
  const dbPath = require.resolve('../config/db'); const rulesPath = require.resolve('../utils/stageRules');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  delete require.cache[rulesPath];
  try { return require(rulesPath); }
  finally { delete require.cache[rulesPath]; if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath]; }
};

const STAGES = [
  { id: 'a', name: 'New', is_won: false, is_lost: false }, { id: 'b', name: 'Qualified', is_won: false, is_lost: false },
  { id: 'c', name: 'Won', is_won: true, is_lost: false }, { id: 'd', name: 'Lost', is_won: false, is_lost: true },
];

test('names: required, trimmed, bounded, and unique per workspace ignoring case and spacing', async () => {
  const r = load(fakeDb({ stages: STAGES }));
  assert.match(r.stageNameError('   '), /required/);
  assert.match(r.stageNameError('x'.repeat(51)), /at most 50/);
  assert.equal(r.stageNameError('  Demo done  '), null);
  assert.equal(await r.duplicateStageName({ tenantId: 't', name: '  won ' }), true);
  assert.equal(await r.duplicateStageName({ tenantId: 't', name: 'Won', exceptId: 'c' }), false, 'a stage is not a duplicate of itself');
  assert.equal(await r.duplicateStageName({ tenantId: 't', name: 'Demo done' }), false);
});

test('renaming a stage that leads or history use is refused with the reason, and nothing is written', async () => {
  const db = fakeDb({ stages: STAGES, leadsByStage: { qualified: 12 }, historyByStage: { qualified: 30 } });
  const r = await load(db).checkStageEdit({ tenantId: 't', stageId: 'b', patch: { name: 'Hot' } });
  assert.equal(r.status, 422);
  assert.match(r.error, /"Qualified" is used by 12 leads and 30 history entries/);
  assert.match(r.error, /drop them from conversion and revenue reports/);
  assert.deepEqual(db.writes, []);
});

test('an unused stage can be renamed, and a change of letter case alone is always allowed', async () => {
  const rules = load(fakeDb({ stages: STAGES, leadsByStage: { won: 5 }, historyByStage: { won: 9 } }));
  assert.deepEqual(await rules.checkStageEdit({ tenantId: 't', stageId: 'a', patch: { name: 'Fresh' } }), { warnings: [] });
  assert.deepEqual(await rules.checkStageEdit({ tenantId: 't', stageId: 'c', patch: { name: 'WON' } }), { warnings: [] }, 'reports match names case-insensitively');
});

test('a rename onto an existing name is a conflict', async () => {
  const r = await load(fakeDb({ stages: STAGES })).checkStageEdit({ tenantId: 't', stageId: 'a', patch: { name: ' qualified ' } });
  assert.equal(r.status, 409); assert.match(r.error, /already exists/);
});

test('the only active won stage cannot be deactivated or un-won while leads refer to it', async () => {
  const used = load(fakeDb({ stages: STAGES, leadsByStage: { won: 3 } }));
  for (const patch of [{ is_active: false }, { is_won: false }]) {
    const r = await used.checkStageEdit({ tenantId: 't', stageId: 'c', patch });
    assert.equal(r.status, 422, JSON.stringify(patch)); assert.match(r.error, /only active won stage and 3 leads and 0 history entries/);
  }
  const unused = load(fakeDb({ stages: STAGES }));
  assert.deepEqual(await unused.checkStageEdit({ tenantId: 't', stageId: 'c', patch: { is_active: false } }), { warnings: [] }, 'nothing refers to it');
  const two = load(fakeDb({ stages: [...STAGES, { id: 'e', name: 'Converted', is_won: true }], leadsByStage: { won: 3 } }));
  assert.deepEqual(await two.checkStageEdit({ tenantId: 't', stageId: 'c', patch: { is_active: false } }), { warnings: [] }, 'another won stage exists');
});

test('changing a won/lost flag on a used stage is allowed but warns how many leads recalculate', async () => {
  const rules = load(fakeDb({ stages: STAGES, leadsByStage: { qualified: 4 }, historyByStage: { qualified: 1 } }));
  const r = await rules.checkStageEdit({ tenantId: 't', stageId: 'b', patch: { is_won: true } });
  assert.deepEqual(r.warnings, ['Changing the won/lost flag recalculates conversions for 4 leads and 1 history entry.']);
  assert.deepEqual((await rules.checkStageEdit({ tenantId: 't', stageId: 'b', patch: { is_won: false } })).warnings, [], 'no change, no warning');
});

test('an unknown stage is a 404; deleting a used stage is refused, an unused one is allowed', async () => {
  const rules = load(fakeDb({ stages: STAGES, leadsByStage: { lost: 2 } }));
  assert.equal((await rules.checkStageEdit({ tenantId: 't', stageId: 'zzz', patch: {} })).status, 404);
  const used = await rules.checkStageDelete({ tenantId: 't', stageId: 'd' });
  assert.equal(used.status, 409); assert.match(used.error, /"Lost" is used by 2 leads and 0 history entries and can't be deleted\. Mark it inactive/);
  assert.deepEqual(await rules.checkStageDelete({ tenantId: 't', stageId: 'a' }), {});
  assert.equal((await rules.checkStageDelete({ tenantId: 't', stageId: 'zzz' })).status, 404);
});

// ---- the endpoints use the rules --------------------------------------------------------------------------------------------
const loadController = (db) => {
  const module = { exports: {} };
  const rules = load(db);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'controllers/settingsController.js'), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, process: { env: {} }, setTimeout, Buffer,
      require: (k) => (k === '../config/db' ? db : k === '../utils/stageRules' ? rules : {}) });
  return module.exports;
};
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const dbWithLog = (base) => { const q = base.query; const seen = []; return { seen, writes: base.writes, query: async (sql, p) => { seen.push(sql.trim().slice(0, 40)); if (/^\s*UPDATE lead_stages/i.test(sql)) return { rows: [{ id: p[6], name: p[0] }] }; if (/^\s*DELETE FROM lead_stages/i.test(sql)) return { rows: [{ id: p[0] }] }; if (/^\s*INSERT INTO lead_stages/i.test(sql)) return { rows: [{ id: 'new' }] }; if (/FROM lead_stages WHERE tenant_id = \$1 ORDER/.test(sql)) return { rows: [] }; if (/count\(\*\)::int AS n FROM lead_stages WHERE tenant_id = \$1$/.test(sql.trim())) return { rows: [{ n: 4 }] }; if (/GREATEST/.test(sql)) return { rows: [{ next_pos: 5 }] }; return q(sql, p); } }; };

test('PUT stage: a refused rename returns 422 and never reaches the UPDATE', async () => {
  const base = dbWithLog(fakeDb({ stages: STAGES, leadsByStage: { qualified: 1 } }));
  const ctrl = loadController(base);
  const r = res();
  await ctrl.updateStage({ params: { id: 'b' }, tenantId: 't', body: { name: 'Hot' } }, r);
  assert.equal(r.code, 422); assert.match(r.data.error, /"Qualified" is used by 1 lead and 0 history entries/);
  assert.ok(!base.seen.some((s) => /^UPDATE lead_stages/i.test(s)));
});

test('PUT stage: an allowed edit passes through; a flag change on a used stage returns the warning', async () => {
  const base = dbWithLog(fakeDb({ stages: STAGES, leadsByStage: { qualified: 2 } }));
  const ctrl = loadController(base);
  const r = res();
  await ctrl.updateStage({ params: { id: 'b' }, tenantId: 't', body: { is_won: true } }, r);
  assert.equal(r.code, 200); assert.match(r.data.warnings[0], /recalculates conversions for 2 leads/);
});

test('DELETE stage: refused when used, performed when unused', async () => {
  const used = dbWithLog(fakeDb({ stages: STAGES, leadsByStage: { lost: 2 } }));
  let r = res(); await loadController(used).deleteStage({ params: { id: 'd' }, tenantId: 't' }, r);
  assert.equal(r.code, 409); assert.ok(!used.seen.some((s) => /^DELETE/i.test(s)));
  const free = dbWithLog(fakeDb({ stages: STAGES }));
  r = res(); await loadController(free).deleteStage({ params: { id: 'a' }, tenantId: 't' }, r);
  assert.equal(r.code, 200); assert.ok(free.seen.some((s) => /^DELETE/i.test(s)));
});

test('POST stage: a duplicate name is a 409 and nothing is inserted', async () => {
  const base = dbWithLog(fakeDb({ stages: STAGES }));
  const r = res(); await loadController(base).createStage({ tenantId: 't', body: { name: ' new ' } }, r);
  assert.equal(r.code, 409); assert.ok(!base.seen.some((s) => /^INSERT/i.test(s)));
  const ok = dbWithLog(fakeDb({ stages: STAGES })); const r2 = res();
  await loadController(ok).createStage({ tenantId: 't', body: { name: 'Demo done' } }, r2);
  assert.equal(r2.code, 201);
});
