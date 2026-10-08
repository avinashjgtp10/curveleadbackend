const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Phase 3: pause/resume + budget changes with a daily cap and an audit trail.

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, process: { env: {} }, setTimeout, require: k => deps[k] || {} });
  return module.exports;
}
const { parseBudgetPaise } = require('../services/metaAds/parseInsights');

test('daily budget total counts CBO campaigns once and ABO ad sets individually, only when active', () => {
  const { dailyBudgetTotal } = load('services/metaAds/controls.js', { './parseInsights': { parseBudgetPaise } });
  const campaigns = [
    { external_id: 'C1', status: 'ACTIVE', daily_budget_paise: 50000 },              // CBO ₹500
    { external_id: 'C2', status: 'ACTIVE', daily_budget_paise: null },               // ABO
    { external_id: 'C3', status: 'PAUSED', daily_budget_paise: 90000 },              // paused CBO
  ];
  const adsets = [
    { external_id: 'S1', campaign_external_id: 'C1', status: 'ACTIVE', daily_budget_paise: 99999 }, // ignored (CBO)
    { external_id: 'S2', campaign_external_id: 'C2', status: 'ACTIVE', daily_budget_paise: 20000 },
    { external_id: 'S3', campaign_external_id: 'C2', status: 'PAUSED', daily_budget_paise: 30000 },
  ];
  assert.equal(dailyBudgetTotal(campaigns, adsets), 70000);
  assert.equal(dailyBudgetTotal(campaigns, adsets, { C3: { status: 'ACTIVE' } }), 160000);
  assert.equal(dailyBudgetTotal(campaigns, adsets, { S3: { status: 'ACTIVE' } }), 100000);
  assert.equal(dailyBudgetTotal(campaigns, adsets, { C2: { status: 'PAUSED' } }), 50000);
});

// Fake world: one CBO campaign C1 (₹500/day) + one ABO campaign C2 with ad set S2 (₹200/day).
const world = ({ scopes = ['ads_read', 'ads_management'], cap = null, metaFails = false, metaEntity = {} } = {}) => {
  const graphCalls = [], audits = [], updates = [];
  const db = {
    query: async (sql, p) => {
      if (sql.includes('FROM ad_campaigns ac WHERE ac.tenant_id')) return { rows: [{ id: 'u-c1', external_id: 'C1', name: 'Diwali', ad_account_id: 'acc', crm_campaign_id: 'crm1' }] };
      if (sql.includes('FROM ad_adsets s JOIN ad_campaigns ac') && sql.includes('s.id = $2')) return { rows: [{ id: 'u-s2', external_id: 'S2', name: 'Pune', ad_account_id: 'acc', campaign_external_id: 'C2' }] };
      if (sql.startsWith('SELECT scopes')) return { rows: [{ scopes }] };
      if (sql.includes("ads_daily_budget_cap_paise")) return { rows: [{ cap: cap == null ? null : String(cap) }] };
      if (sql.startsWith('SELECT external_id, status')) return { rows: [{ external_id: 'C1', status: 'ACTIVE', daily_budget_paise: 50000 }, { external_id: 'C2', status: 'ACTIVE', daily_budget_paise: null }] };
      if (sql.startsWith('SELECT s.external_id')) return { rows: [{ external_id: 'S2', status: 'ACTIVE', daily_budget_paise: 20000, campaign_external_id: 'C2' }] };
      if (sql.startsWith('INSERT INTO ad_audit_log')) { audits.push(p); return { rows: [] }; }
      if (sql.startsWith('UPDATE')) { updates.push([sql, p]); return { rows: [] }; }
      return { rows: [] };
    },
  };
  db.transaction = (fn) => fn(db);
  const ctrl = load('services/metaAds/controls.js', {
    '../../config/db': db,
    '../../utils/workspaceLocale': require('../utils/workspaceLocale'),
    './parseInsights': { parseBudgetPaise },
    './client': { getAccountWithToken: async () => ({ token: 'tok', account: { external_id: 'act_1', token_status: 'active', token_row_id: 'tk' } }) },
    '../../utils/metaGraph': { graphRequest: async (opts) => {
      graphCalls.push(opts);
      if (opts.method === 'POST') { if (metaFails) throw Object.assign(new Error('(#100) Budget is too low'), { name: 'MetaGraphError', code: 100 }); return { success: true }; }
      const id = opts.path.slice(1);
      const base = id === 'C1' ? { name: 'Diwali', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '50000' }
        : { name: 'Pune', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '20000', campaign: {} };
      const posted = graphCalls.filter(c => c.method === 'POST' && c.path === opts.path).pop();
      return { ...base, ...(metaEntity[id] || {}), ...(posted ? posted.data : {}) };
    } },
  });
  return { ctrl, graphCalls, audits, updates };
};

test('without ads_management the change is refused before calling Meta', async () => {
  const { ctrl, graphCalls } = world({ scopes: ['ads_read'] });
  await assert.rejects(ctrl.changeEntity({ tenantId: 't', userId: 'u', entityType: 'campaign', id: 'u-c1', action: 'pause' }), e => e.status === 403);
  assert.equal(graphCalls.length, 0);
});

test('pausing writes to Meta, updates the cache and CRM campaign, and audits old → new', async () => {
  const { ctrl, graphCalls, audits, updates } = world();
  const result = await ctrl.changeEntity({ tenantId: 't', userId: 'u', entityType: 'campaign', id: 'u-c1', action: 'pause' });
  assert.equal(result.old_value.status, 'ACTIVE');
  assert.equal(result.new_value.status, 'PAUSED');
  const post = graphCalls.find(c => c.method === 'POST');
  assert.deepEqual({ ...post.data }, { status: 'PAUSED' });
  assert.ok(updates.some(([sql]) => sql.startsWith('UPDATE ad_campaigns')));
  assert.ok(updates.some(([sql, p]) => sql.startsWith('UPDATE campaigns') && p[2] === 'paused'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0][6], 'pause');
  assert.equal(audits[0][11], true);
});

test('ad set budget on a CBO campaign, campaign budget on an ABO campaign and lifetime budgets are rejected', async () => {
  let { ctrl, graphCalls } = world({ metaEntity: { S2: { campaign: { daily_budget: '50000' } } } });
  await assert.rejects(ctrl.changeEntity({ tenantId: 't', entityType: 'adset', id: 'u-s2', action: 'update_budget', dailyBudgetPaise: 30000 }), /Advantage campaign budget/);
  assert.ok(!graphCalls.some(c => c.method === 'POST'));

  ({ ctrl } = world({ metaEntity: { C1: { daily_budget: undefined } } }));
  await assert.rejects(ctrl.changeEntity({ tenantId: 't', entityType: 'campaign', id: 'u-c1', action: 'update_budget', dailyBudgetPaise: 30000 }), /set on its ad sets/);

  ({ ctrl } = world({ metaEntity: { C1: { daily_budget: undefined, lifetime_budget: '1000000' } } }));
  await assert.rejects(ctrl.changeEntity({ tenantId: 't', entityType: 'campaign', id: 'u-c1', action: 'update_budget', dailyBudgetPaise: 30000 }), /lifetime budget/);
});

test('a budget increase above the daily cap is refused; decreases always pass', async () => {
  // Active today: C1 ₹500 + S2 ₹200 = ₹700; cap ₹800.
  let { ctrl, graphCalls } = world({ cap: 80000 });
  await assert.rejects(ctrl.changeEntity({ tenantId: 't', entityType: 'campaign', id: 'u-c1', action: 'update_budget', dailyBudgetPaise: 70000 }), (e) => e.status === 422 && /above your cap of ₹800/.test(e.message));
  assert.ok(!graphCalls.some(c => c.method === 'POST'));

  ({ ctrl, graphCalls } = world({ cap: 80000 }));
  await ctrl.changeEntity({ tenantId: 't', entityType: 'campaign', id: 'u-c1', action: 'update_budget', dailyBudgetPaise: 55000 });
  assert.deepEqual({ ...graphCalls.find(c => c.method === 'POST').data }, { daily_budget: '55000' });

  ({ ctrl, graphCalls } = world({ cap: 10000 })); // already over the cap: lowering is still allowed
  await ctrl.changeEntity({ tenantId: 't', entityType: 'campaign', id: 'u-c1', action: 'update_budget', dailyBudgetPaise: 40000 });
  assert.ok(graphCalls.some(c => c.method === 'POST'));
});

test('a failed Meta write is audited as a failure and nothing is cached', async () => {
  const { ctrl, audits, updates } = world({ metaFails: true });
  await assert.rejects(ctrl.changeEntity({ tenantId: 't', userId: 'u', entityType: 'campaign', id: 'u-c1', action: 'update_budget', dailyBudgetPaise: 30000 }), /Facebook: \(#100\) Budget is too low/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0][11], false);
  assert.match(audits[0][12], /Budget is too low/);
  assert.equal(updates.length, 0);
});

test('pausing something already paused does nothing', async () => {
  const { ctrl, graphCalls, audits } = world({ metaEntity: { C1: { status: 'PAUSED' } } });
  const result = await ctrl.changeEntity({ tenantId: 't', entityType: 'campaign', id: 'u-c1', action: 'pause' });
  assert.equal(result.unchanged, true);
  assert.ok(!graphCalls.some(c => c.method === 'POST'));
  assert.equal(audits.length, 0);
});
