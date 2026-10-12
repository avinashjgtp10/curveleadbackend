// Phase 1 milestone writes: a lead's stage change and its critical milestone columns are written together in
// ONE transaction, milestone errors propagate, a repeat Won never moves won_at (first Won event is canonical),
// exactly one history row exists per transition, and noncritical follow-ups run only after commit.
// In-memory fakes: they model rows, the history trigger, transactions and rollback. The real SQL runs against
// PostgreSQL in tests/leadStageMilestoneSql.test.js (skipped without BATCH1_TEST_DATABASE_URL).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ---- fake database ---------------------------------------------------------------------------------
const STAGES = [
  { name: 'New', is_won: false, is_lost: false }, { name: 'Qualified', is_won: false, is_lost: false },
  { name: 'Won', is_won: true, is_lost: false }, { name: 'Converted', is_won: true, is_lost: false },
  { name: 'Lost', is_won: false, is_lost: true },
];
const fakeDb = ({ trigger = true, failOn = null } = {}) => {
  const state = { lead: { id: 'L1', stage: 'New', won_at: null, lost_at: null, lost_reason: null }, history: [], activities: [], log: [], txn: 0, committed: 0, rolledBack: 0 };
  let snap = null; let inTxn = false; let clock = 0;
  const now = () => `t${++clock}`;
  const exec = async (sql, params = []) => {
    state.log.push(sql.trim().replace(/\s+/g, ' ').slice(0, 120));
    if (failOn && failOn.test(sql)) throw new Error(`forced failure: ${failOn}`);
    if (/FROM leads WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/.test(sql)) return { rows: params[0] === 'L1' ? [{ stage: state.lead.stage, won_at: state.lead.won_at }] : [] };
    if (/FROM lead_stages WHERE/.test(sql)) return { rows: STAGES.filter((s) => s.name.toLowerCase() === String(params[1]).toLowerCase()) };
    if (/count\(\*\)::int AS n FROM lead_stage_history/.test(sql)) return { rows: [{ n: state.history.length }] };
    if (/^UPDATE leads SET/.test(sql.trim())) {
      const prev = state.lead.stage;
      state.lead.stage = params[0];
      if (/won_at = COALESCE\(won_at, NOW\(\)\)/.test(sql)) state.lead.won_at = state.lead.won_at || now();
      if (/lost_at = NOW\(\)/.test(sql)) state.lead.lost_at = now();
      const m = /lost_reason = \$(\d+)/.exec(sql); if (m) state.lead.lost_reason = params[Number(m[1]) - 1];
      if (trigger && prev !== params[0]) state.history.push({ prev, next: params[0], by: 'trigger' });
      return { rows: [{ ...state.lead }] };
    }
    if (/INSERT INTO lead_stage_history/.test(sql)) { state.history.push({ prev: params[2], next: params[3], by: 'service' }); return { rows: [] }; }
    if (/INSERT INTO lead_activities/.test(sql)) { state.activities.push({ title: params[2], afterCommit: state.committed > 0 && !inTxn }); return { rows: [] }; }
    return { rows: [] };
  };
  const client = { query: exec };
  const db = {
    state, query: exec, client,
    transaction: async (fn) => {
      state.txn++; inTxn = true; snap = JSON.stringify({ lead: state.lead, history: state.history });
      try { const r = await fn(client); inTxn = false; state.committed++; return r; }
      catch (e) { inTxn = false; state.rolledBack++; const s = JSON.parse(snap); state.lead = s.lead; state.history = s.history; throw e; }
    },
  };
  return db;
};

const triggers = [];
const loadLeadStage = (db) => {
  const dbPath = require.resolve('../config/db');
  const trigPath = require.resolve('../utils/automationTriggers');
  const savedDb = require.cache[dbPath]; const savedTr = require.cache[trigPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  require.cache[trigPath] = { id: trigPath, filename: trigPath, loaded: true, exports: { checkStageChangeTriggers: async (a) => { triggers.push(a); } } };
  const lsPath = require.resolve('../utils/leadStage');
  delete require.cache[lsPath];
  try { return require(lsPath); }
  finally {
    delete require.cache[lsPath];
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    if (savedTr) require.cache[trigPath] = savedTr; else delete require.cache[trigPath];
  }
};
const args = (over = {}) => ({ tenantId: 't1', leadId: 'L1', newStageName: 'Won', ...over });

// ---- the core -----------------------------------------------------------------------------------------
test('a stage change updates the stage and first-Won date in one transaction, with exactly one history row', async () => {
  const db = fakeDb(); const ls = loadLeadStage(db);
  const r = await ls.changeLeadStage(args());
  assert.equal(r.changed, true); assert.equal(r.firstWon, true); assert.equal(r.stage, 'Won');
  assert.equal(db.state.txn, 1); assert.equal(db.state.committed, 1);
  assert.equal(db.state.lead.won_at, 't1');
  assert.equal(db.state.history.length, 1);
});

test('the history is recorded here exactly once when no database trigger recorded it', async () => {
  const db = fakeDb({ trigger: false }); const ls = loadLeadStage(db);
  await ls.changeLeadStage(args());
  assert.deepEqual(db.state.history.map((h) => [h.prev, h.next, h.by]), [['New', 'Won', 'service']]);
  const withTrigger = fakeDb({ trigger: true }); await loadLeadStage(withTrigger).changeLeadStage(args());
  assert.deepEqual(withTrigger.state.history.map((h) => h.by), ['trigger'], 'with the trigger present there is no second row');
});

test('a repeat Won never moves won_at and never counts the customer twice (Won -> Converted -> Won -> Lost -> Won)', async () => {
  const db = fakeDb(); const ls = loadLeadStage(db);
  const first = await ls.changeLeadStage(args({ newStageName: 'Won' }));
  const firstDate = db.state.lead.won_at;
  const second = await ls.changeLeadStage(args({ newStageName: 'Converted' }));
  await ls.changeLeadStage(args({ newStageName: 'Lost', lostReason: 'changed mind' }));
  const again = await ls.changeLeadStage(args({ newStageName: 'Won' }));
  assert.equal(first.firstWon, true);
  assert.equal(second.firstWon, false, 'moving between won stages is not a new customer');
  assert.equal(again.firstWon, false, 'coming back to Won is not a new customer');
  assert.equal(db.state.lead.won_at, firstDate, 'won_at stays the first Won date');
  assert.equal(db.state.history.length, 4, 'every real transition is still audited once');
});

test('the same stage (any case) is a no-op: no update, no history, no follow-ups', async () => {
  const db = fakeDb(); const ls = loadLeadStage(db);
  db.state.lead.stage = 'Won';
  triggers.length = 0;
  const r = await ls.changeLeadStage(args({ newStageName: 'won' }));
  assert.deepEqual([r.changed, r.reason], [false, 'same_stage']);
  assert.equal(db.state.history.length, 0); assert.equal(db.state.activities.length, 0); assert.equal(triggers.length, 0);
  assert.ok(!db.state.log.some((l) => /^UPDATE leads/.test(l)));
});

test('an unknown lead changes nothing', async () => {
  const db = fakeDb(); const ls = loadLeadStage(db);
  const r = await ls.changeLeadStage(args({ leadId: 'nope' }));
  assert.deepEqual([r.changed, r.reason], [false, 'not_found']);
});

test('entering a lost stage sets lost_at and the reason; the lead row is locked first', async () => {
  const db = fakeDb(); const ls = loadLeadStage(db);
  await ls.changeLeadStage(args({ newStageName: 'Lost', lostReason: 'too expensive' }));
  assert.equal(db.state.lead.lost_at, 't1'); assert.equal(db.state.lead.lost_reason, 'too expensive');
  assert.match(db.state.log[0], /FROM leads WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/);
});

test('the canonical stage name from the workspace is stored, whatever case the caller used', async () => {
  const db = fakeDb(); const ls = loadLeadStage(db);
  await ls.changeLeadStage(args({ newStageName: 'qUaLiFiEd' }));
  assert.equal(db.state.lead.stage, 'Qualified');
});

// ---- errors are never swallowed; noncritical work cannot undo a committed change -----------------------------
test('a milestone-integrity error rolls the whole change back and reaches the caller', async () => {
  for (const failOn of [/^UPDATE leads/, /INSERT INTO lead_stage_history/, /count\(\*\)::int AS n FROM lead_stage_history/]) {
    const db = fakeDb({ trigger: false, failOn }); const ls = loadLeadStage(db);
    triggers.length = 0;
    await assert.rejects(ls.changeLeadStage(args()), /forced failure/, String(failOn));
    assert.equal(db.state.rolledBack, 1, String(failOn)); assert.equal(db.state.committed, 0);
    assert.equal(db.state.lead.stage, 'New', 'nothing half-applied'); assert.equal(db.state.lead.won_at, null);
    assert.equal(db.state.activities.length, 0, 'no follow-up for a change that did not happen'); assert.equal(triggers.length, 0);
  }
});

test('noncritical follow-ups run only after the commit and a failure there does not undo the stage change', async () => {
  const db = fakeDb({ failOn: /INSERT INTO lead_activities/ }); const ls = loadLeadStage(db);
  triggers.length = 0;
  const r = await ls.changeLeadStage(args());
  assert.equal(r.changed, true); assert.equal(db.state.lead.stage, 'Won', 'the change stands');
  assert.equal(db.state.committed, 1);
  assert.deepEqual(triggers.map((t) => [t.newStage, t.isWon]), [['Won', true]]);
  const ok = fakeDb(); await loadLeadStage(ok).changeLeadStage(args());
  assert.equal(ok.state.activities[0].afterCommit, true, 'the activity is written after the commit, not inside the transaction');
});

test('joining a caller\'s transaction: no second transaction, follow-ups deferred until the caller commits', async () => {
  const db = fakeDb(); const ls = loadLeadStage(db);
  triggers.length = 0;
  const r = await ls.changeLeadStage({ ...args(), client: db.client });
  assert.equal(db.state.txn, 0, 'it did not open its own transaction');
  assert.equal(db.state.activities.length, 0); assert.equal(triggers.length, 0);
  await r.afterCommit();
  assert.equal(db.state.activities.length, 1); assert.equal(triggers.length, 1);
});

test('no history insert is wrapped in a swallowing catch any more', () => {
  const src = read('utils/leadStage.js');
  const insert = src.slice(src.indexOf('INSERT INTO lead_stage_history'), src.indexOf('INSERT INTO lead_stage_history') + 400);
  assert.doesNotMatch(insert.split(']);')[0] + ']);', /\.catch\(/);
  assert.match(src, /won_at = COALESCE\(won_at, NOW\(\)\)/);
  assert.doesNotMatch(src, /won_at = NOW\(\)/);
});

// ---- the human-facing paths use the same rules ------------------------------------------------------------------
function loadVm(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(read(file), { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, Intl, Math, Number, String, Array, Object, process: { env: {} }, setTimeout, require: (k) => deps[k] || {} });
  return module.exports;
}
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

test('updateLead keeps the first Won date and moves lost_at only on a real change', () => {
  const src = read('controllers/leadController.js');
  assert.match(src, /updates\.push\('won_at = COALESCE\(won_at, NOW\(\)\)'\)/);
  assert.doesNotMatch(src, /updates\.push\('won_at = NOW\(\)'\)/);
  assert.match(src, /if \(req\.body\.stage !== prev\.stage\) updates\.push\('lost_at = NOW\(\)'\)/);
});

test('bulkUpdate sets won_at (first Won) and lost_at together with the stage, in one statement', async () => {
  const seen = [];
  const db = { query: async (sql, params) => {
    seen.push({ sql: sql.replace(/\s+/g, ' '), params });
    if (/FROM lead_stages/.test(sql)) return { rows: [{ name: 'Won', is_won: true, is_lost: false }] };
    if (/SELECT id,stage FROM leads/.test(sql)) return { rows: [{ id: 'a', stage: 'New' }, { id: 'b', stage: 'Won' }] };
    return { rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 };
  } };
  const ctrl = loadVm('controllers/leadController.js', { '../config/db': db, '../utils/dataQuality': require('../utils/dataQuality') });
  const r = res();
  await ctrl.bulkUpdate({ tenantId: 't', user: { id: 'u' }, body: { ids: ['a', 'b'], stage: 'won' } }, r);
  assert.equal(r.code, 200); assert.equal(r.data.updated, 2);
  const upd = seen.find((c) => /^UPDATE leads SET/.test(c.sql));
  assert.match(upd.sql, /stage = \$2, updated_at|stage = \$2,/);
  assert.match(upd.sql, /won_at = CASE WHEN LOWER\(COALESCE\(stage, ''\)\) <> LOWER\(\$2\) THEN COALESCE\(won_at, NOW\(\)\) ELSE won_at END/);
  assert.doesNotMatch(upd.sql, /lost_at/);
  assert.equal(upd.params[1], 'Won', 'the workspace\'s own stage name is stored');
  // a plain assignment change touches no milestone column
  seen.length = 0;
  await ctrl.bulkUpdate({ tenantId: 't', user: { id: 'u' }, body: { ids: ['a'], assigned_to: 'x' } }, res());
  assert.doesNotMatch(seen.find((c) => /^UPDATE leads SET/.test(c.sql)).sql, /won_at|lost_at/);
});

test('bulkUpdate into a lost stage sets lost_at only for leads that actually change', async () => {
  const seen = [];
  const db = { query: async (sql, params) => { seen.push({ sql: sql.replace(/\s+/g, ' '), params });
    if (/FROM lead_stages/.test(sql)) return { rows: [{ name: 'Lost', is_won: false, is_lost: true }] };
    return { rows: [], rowCount: 0 }; } };
  const ctrl = loadVm('controllers/leadController.js', { '../config/db': db, '../utils/dataQuality': require('../utils/dataQuality') });
  await ctrl.bulkUpdate({ tenantId: 't', user: { id: 'u' }, body: { ids: ['a'], stage: 'Lost' } }, res());
  assert.match(seen.find((c) => /^UPDATE leads SET/.test(c.sql)).sql, /lost_at = CASE WHEN LOWER\(COALESCE\(stage, ''\)\) <> LOWER\(\$2\) THEN NOW\(\) ELSE lost_at END/);
});

test('the follow-up review that marks a lead lost also records lost_at, inside its existing transaction', () => {
  const src = read('controllers/followupController.js');
  assert.match(src, /lost_at=CASE WHEN lower\(coalesce\(stage,''\)\)<>lower\(\$1\) THEN now\(\) ELSE lost_at END/);
});

for (const [name, file, fn, body] of [
  ['quotationsController.acceptQuotation', 'controllers/quotationsController.js', 'acceptQuotation', {}],
  ['quotationController.accept', 'controllers/quotationController.js', 'accept', {}],
]) {
  test(`${name}: accepting, the Won transition and the deal value are one transaction`, async () => {
    const calls = [];
    let failStage = false; let committed = false;
    const client = { query: async (sql) => {
      calls.push(sql.trim().replace(/\s+/g, ' ').slice(0, 40));
      if (/^UPDATE quotations/.test(sql.trim())) return { rows: [{ lead_id: 'L1', total: 500 }] };
      return { rows: [] };
    } };
    const db = { query: async () => ({ rows: [] }), transaction: async (fn) => { calls.push('BEGIN'); try { const r = await fn(client); calls.push('COMMIT'); committed = true; return r; } catch (e) { calls.push('ROLLBACK'); throw e; } } };
    const leadStage = { wonStageName: async () => 'Won', changeLeadStage: async (a) => {
      assert.ok(a.client === client, 'the stage change joins the caller\'s transaction');
      if (failStage) throw new Error('milestone failed');
      calls.push('stage-change'); return { changed: true, afterCommit: async () => { assert.equal(committed, true, 'follow-ups only after commit'); calls.push('after-commit'); } };
    } };
    const ctrl = loadVm(file, { '../config/db': { ...db, transaction: db.transaction }, '../utils/leadStage': leadStage });
    // controllers `require` leadStage lazily inside the handler, config/db at the top
    const r = res();
    await ctrl[fn]({ params: { id: 'Q1' }, tenantId: 't', user: { id: 'u' }, body }, r);
    assert.equal(r.code, 200, JSON.stringify(r.data));
    assert.deepEqual(calls.filter((c) => ['BEGIN', 'COMMIT', 'ROLLBACK', 'stage-change', 'after-commit'].includes(c)), ['BEGIN', 'stage-change', 'COMMIT', 'after-commit']);

    calls.length = 0; committed = false; failStage = true;
    const r2 = res();
    await ctrl[fn]({ params: { id: 'Q1' }, tenantId: 't', user: { id: 'u' }, body }, r2);
    assert.equal(r2.code, 500, 'a failed Won transition fails the acceptance');
    assert.ok(calls.includes('ROLLBACK') && !calls.includes('COMMIT'), 'and the quotation is not left accepted');
    assert.ok(!calls.includes('after-commit'));
  });
}
