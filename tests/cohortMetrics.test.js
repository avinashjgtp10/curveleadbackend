// Cohort metrics: the money rules (pure), the response assembly, the reporting flag and the API gating.
// The SQL itself runs against PostgreSQL in tests/phase1CohortSql.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const loadWith = (file, mocks) => {
  const saved = {}; const paths = Object.keys(mocks).map((k) => [k, require.resolve(k)]);
  for (const [k, p] of paths) { saved[p] = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: mocks[k] }; }
  const f = require.resolve(file); delete require.cache[f];
  try { return require(f); } finally { delete require.cache[f]; for (const [, p] of paths) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } }
};
const cohort = loadWith('../services/cohortMetrics', { '../config/db': { query: async () => ({ rows: [] }) }, '../services/metrics': { metricScope: async () => ({}), adSpend: async () => [], getMetrics: async () => ({}) } });
const { computeRatios } = cohort;

test('the worked example: Rs 20,000 booked, Rs 13,000 collected, Rs 10,000 spend -> ROAS 2.00 / 1.30, ROI 30.0%', () => {
  const r = computeRatios({ leads: 4, qualified: 2, acquired: 1, spend: { measured: true, byCurrency: { INR: 10000 } }, booked: { INR: 20000 }, collected: { INR: 13000 } });
  assert.deepEqual([r.ratios.booked_roas.value, r.ratios.collected_roas.value, r.ratios.advertising_roi_pct.value], [2, 1.3, 30]);
  assert.deepEqual([r.ratios.cpl.value, r.ratios.cost_per_qualified.value, r.ratios.cac.value], [2500, 5000, 10000]);
  assert.equal(r.spend, 10000); assert.equal(r.spend_currency, 'INR');
});

test('the same data with spend in another currency: every revenue ratio is null with currency_mismatch, unit costs still work', () => {
  const r = computeRatios({ leads: 4, qualified: 2, acquired: 1, spend: { measured: true, byCurrency: { USD: 120 } }, booked: { INR: 20000 }, collected: { INR: 13000 } });
  for (const k of ['booked_roas', 'collected_roas', 'advertising_roi_pct']) assert.deepEqual(r.ratios[k], { value: null, reason: 'currency_mismatch' }, k);
  assert.equal(r.ratios.cpl.value, 30); assert.equal(r.ratios.cac.value, 120);
});

test('revenue in several currencies never blends: a foreign amount blocks the ratio, a zero foreign amount does not', () => {
  const spend = { measured: true, byCurrency: { INR: 1000 } };
  assert.equal(computeRatios({ leads: 1, qualified: 1, acquired: 1, spend, booked: { INR: 2000, USD: 50 }, collected: { INR: 1000 } }).ratios.booked_roas.reason, 'currency_mismatch');
  assert.equal(computeRatios({ leads: 1, qualified: 1, acquired: 1, spend, booked: { INR: 2000, USD: 0 }, collected: { INR: 1000 } }).ratios.booked_roas.value, 2);
});

test('spend problems get their own reasons and no ratio is ever Infinity or NaN', () => {
  const base = { leads: 3, qualified: 1, acquired: 1, booked: { INR: 100 }, collected: { INR: 100 } };
  const reasons = (spend) => Object.fromEntries(Object.entries(computeRatios({ ...base, spend }).ratios).map(([k, v]) => [k, v.reason]));
  for (const k of Object.values(reasons({ measured: false, byCurrency: {} }))) assert.equal(k, 'not_measured', 'a campaign with no spend rows is not measured, not zero');
  for (const k of Object.values(reasons({ measured: true, byCurrency: { INR: 0 } }))) assert.equal(k, 'no_spend');
  for (const k of Object.values(reasons({ measured: true, byCurrency: { INR: 10, USD: 5 } }))) assert.equal(k, 'mixed_spend_currencies');
  const all = computeRatios({ leads: 0, qualified: 0, acquired: 0, spend: { measured: true, byCurrency: { INR: 500 } }, booked: {}, collected: {} }).ratios;
  assert.deepEqual([all.cpl.reason, all.cost_per_qualified.reason, all.cac.reason], ['no_leads', 'no_qualified', 'no_customers']);
  assert.equal(all.collected_roas.value, 0, 'spend with no revenue yet is a real 0.00, not a missing number');
  for (const v of Object.values(all)) assert.ok(v.value === null || Number.isFinite(v.value));
});

test('ROI is (collected - spend) / spend and can be negative', () => {
  assert.equal(computeRatios({ leads: 1, qualified: 1, acquired: 1, spend: { measured: true, byCurrency: { INR: 1000 } }, booked: {}, collected: { INR: 400 } }).ratios.advertising_roi_pct.value, -60);
});

// ---- assembly from query rows -----------------------------------------------------------------------------------------------------
const C1 = '11111111-1111-1111-1111-111111111111', C2 = '22222222-2222-2222-2222-222222222222';
const rows = {
  counts: [{ campaign_id: C1, leads: 4, qualified: 3, acquired: 2, cancelled: 1, verified: 3, inferred: 1, unattributed: 0, won_without_event: 0 },
    { campaign_id: null, leads: 2, qualified: 1, acquired: 1, cancelled: 0, verified: 0, inferred: 0, unattributed: 2, won_without_event: 1 }],
  booked: [{ campaign_id: C1, currency: 'INR', amount: '28000.00', leads: 2, adjusted: 1, inferred: 0 }, { campaign_id: null, currency: 'INR', amount: '5000', leads: 1, adjusted: 0, inferred: 1 }],
  collected: [{ campaign_id: C1, currency: 'INR', paid_on_basis: 'confirmed', on_won_lead: true, net: '13000.00', pending: '0' },
    { campaign_id: C1, currency: 'INR', paid_on_basis: 'unknown', on_won_lead: false, net: '3000.00', pending: '500' },
    { campaign_id: null, currency: 'INR', paid_on_basis: 'confirmed', on_won_lead: true, net: '5000', pending: '0' }],
};
const spendRows = [{ campaign_id: C1, currency: 'INR', spend: 10000, platform_leads: 7 }, { campaign_id: C2, currency: 'INR', spend: 500, platform_leads: 0 }];

test('groups assemble per campaign with won / non-won collected lines and date-basis breakdown; spend-only campaigns appear', () => {
  const groups = cohort.buildGroups(rows, spendRows);
  const g = cohort.present(groups.get(C1), new Map([[C1, 'Diwali offer']]));
  assert.equal(g.campaign_name, 'Diwali offer');
  assert.deepEqual([g.leads, g.qualified, g.acquired, g.cancelled], [4, 3, 2, 1]);
  assert.deepEqual(g.booked, [{ currency: 'INR', amount: 28000 }]);
  assert.deepEqual(g.collected.net, [{ currency: 'INR', amount: 16000 }]);
  assert.deepEqual(g.collected.on_won_leads, [{ currency: 'INR', amount: 13000 }]);
  assert.deepEqual(g.collected.on_non_won_leads, [{ currency: 'INR', amount: 3000 }], 'money from leads not yet Won has its own line');
  assert.deepEqual(g.collected.by_date_basis.confirmed, [{ currency: 'INR', amount: 13000 }]);
  assert.deepEqual(g.collected.by_date_basis.unknown, [{ currency: 'INR', amount: 3000 }], 'undated money is disclosed, not blended');
  assert.deepEqual(g.collected.pending_not_counted, [{ currency: 'INR', amount: 500 }]);
  assert.deepEqual([g.ratios.cpl.value, g.ratios.cac.value, g.ratios.booked_roas.value, g.ratios.collected_roas.value, g.ratios.advertising_roi_pct.value], [2500, 5000, 2.8, 1.6, 60]);
  const spendOnly = cohort.present(groups.get(C2), new Map());
  assert.deepEqual([spendOnly.leads, spendOnly.spend.amount, spendOnly.ratios.cpl.reason], [0, 500, 'no_leads']);
});

test('unattributed leads get their own row with no spend and no ratios, and never zero-spend ratios', () => {
  const u = cohort.present(cohort.buildGroups(rows, spendRows).get(null), new Map());
  assert.equal(u.unattributed, true); assert.equal(u.spend.reason, 'not_applicable_unattributed');
  for (const v of Object.values(u.ratios)) assert.deepEqual(v, { value: null, reason: 'not_applicable_unattributed' });
});

test('spend helper adds within a currency only and flags measured', () => {
  assert.deepEqual(cohort.spendOf([]), { measured: false, byCurrency: {} });
  assert.deepEqual(cohort.spendOf([{ currency: 'INR', spend: 1.1 }, { currency: 'INR', spend: 2.2 }, { currency: 'USD', spend: 5 }]), { measured: true, byCurrency: { INR: 3.3, USD: 5 } });
});

// ---- the module's discipline (static) -------------------------------------------------------------------------------------------------
test('the cohort module only reads: no write statements, tenant is always the first bound parameter', () => {
  const src = read('services/cohortMetrics.js').replace(/\/\/.*$/gm, '');
  const writes = src.match(/\b(UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+\w+|ALTER\s+TABLE)\b/gi);
  assert.equal(writes, null);
  assert.deepEqual(src.match(/INSERT INTO \w+/g), ['INSERT INTO metric_shadow_log'], 'the only insert is the shadow comparison log');
  assert.match(src, /l\.tenant_id = \$1/);
  assert.match(src, /NOT COALESCE\(l\.is_test_lead, false\)/, 'test leads are excluded');
  assert.match(src, /l\.merged_into_id IS NULL/, 'merged duplicates are excluded');
  assert.match(src, /\(e\.lead_id = c\.id OR e\.lead_id IN \(SELECT m\.id FROM leads m WHERE m\.tenant_id = \$1 AND m\.merged_into_id = c\.id\)\)/, 'a person is acquired if any of their merged leads was');
});

// ---- flag and API --------------------------------------------------------------------------------------------------------------------------
test('reporting mode is off unless the workspace says shadow or on; the kill switch wins', async () => {
  const mk = (m, fail = false) => loadWith('../utils/reportingFlags', { '../config/db': { query: async () => { if (fail) throw new Error('down'); return { rows: [{ m }] }; } } });
  for (const [m, want] of [[null, 'off'], ['off', 'off'], ['shadow', 'shadow'], ['on', 'on'], ['yes', 'off'], ['ON', 'off']]) assert.equal(await mk(m).reportingMode('t'), want, String(m));
  assert.equal(await mk('on', true).reportingMode('t'), 'off');
  process.env.REPORTING_COHORT_KILL = '1';
  try { assert.equal(await mk('on').reportingMode('t'), 'off'); } finally { delete process.env.REPORTING_COHORT_KILL; }
});

const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const controller = (mode, svc = {}) => loadWith('../controllers/cohortController', {
  '../services/cohortMetrics': { getCohortMetrics: async () => ({ cohort: { totals: { leads: 1, acquired: 0, qualified: 0 } }, scope: { workspaceId: 't' } }), recordShadow: async () => [{ metric: 'leads', legacy: 1, cohort: 1, delta: 0 }], getHealth: async () => ({ ok: true, checks: [] }), ...svc },
  '../utils/reportingFlags': { reportingMode: async () => mode },
});

test('API: off answers 404 feature_off; shadow is administrators only and returns the comparison; on serves everyone with access', async () => {
  let r = res(); await controller('off').metrics({ tenantId: 't', user: { role: 'admin' }, query: {} }, r); assert.deepEqual([r.code, r.data.error], [404, 'feature_off']);
  r = res(); await controller('shadow').metrics({ tenantId: 't', user: { role: 'staff' }, query: {} }, r); assert.equal(r.code, 403);
  r = res(); await controller('shadow').metrics({ tenantId: 't', user: { role: 'admin' }, query: {} }, r); assert.deepEqual([r.code, r.data.mode, r.data.shadow[0].metric], [200, 'shadow', 'leads']);
  r = res(); await controller('on').metrics({ tenantId: 't', user: { role: 'staff' }, query: {} }, r); assert.deepEqual([r.code, r.data.mode, r.data.shadow], [200, 'on', undefined]);
  r = res(); await controller('off').health({ tenantId: 't', user: { role: 'admin' }, query: {} }, r); assert.equal(r.code, 404);
  r = res(); await controller('on').health({ tenantId: 't', user: { role: 'admin' }, query: {} }, r); assert.deepEqual([r.code, r.data.ok], [200, true]);
});

test('API: campaign filters are validated, a missing migration is a clear 503, other errors never leak', async () => {
  const c = controller('on');
  assert.deepEqual(c.parseCampaigns('11111111-1111-1111-1111-111111111111, 22222222-2222-2222-2222-222222222222').ids.length, 2);
  assert.equal(c.parseCampaigns(undefined).ids, null);
  assert.ok(c.parseCampaigns('nope').error); assert.ok(c.parseCampaigns(Array(51).fill('11111111-1111-1111-1111-111111111111').join(',')).error);
  let r = res(); await c.metrics({ tenantId: 't', user: { role: 'admin' }, query: { campaign_id: 'x' } }, r); assert.equal(r.code, 422);
  const missing = Object.assign(new Error('Cohort reporting is not set up in this database yet.'), { code: 'cohort_unavailable', missing: [{ object: 'lead_payments' }] });
  r = res(); await controller('on', { getCohortMetrics: async () => { throw missing; } }).metrics({ tenantId: 't', user: { role: 'admin' }, query: {} }, r);
  assert.deepEqual([r.code, r.data.code, r.data.missing[0].object], [503, 'cohort_unavailable', 'lead_payments']);
  const quiet = console.error; console.error = () => {};
  try { r = res(); await controller('on', { getCohortMetrics: async () => { throw new Error('select password from secrets'); } }).metrics({ tenantId: 't', user: { role: 'admin' }, query: {} }, r); } finally { console.error = quiet; }
  assert.equal(r.code, 500); assert.doesNotMatch(JSON.stringify(r.data), /password|secrets/);
});

test('routes: cohort metrics need finance.view, health needs an administrator, both behind authentication; the router is mounted', () => {
  const routes = read('routes/cohort.js');
  assert.match(routes, /router\.use\(authenticate, tenantContext\)/);
  assert.match(routes, /router\.get\('\/metrics', requirePermission\('finance\.view'\), ctrl\.metrics\)/);
  assert.match(routes, /router\.get\('\/health', adminOnly, ctrl\.health\)/);
  assert.match(read('server.js'), /app\.use\('\/api\/cohort', apiLimiter, require\('\.\/routes\/cohort'\)\)/);
});
