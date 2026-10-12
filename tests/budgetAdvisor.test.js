const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { advise, DEFAULTS, median } = require('../services/budgetAdvisor');

const camp = (id, { spend = 5000, cur = 'INR', leads = 40, customers = 5, booked = 10000 } = {}) => ({
  campaign_id: id, campaign_name: id, leads, acquired: customers,
  spend: { amount: spend, currency: cur, reason: null }, booked: [{ currency: 'INR', amount: booked }], collected: { net: [{ currency: 'INR', amount: booked / 2 }] },
});
const mature = { attribution: { coverage_pct: 90 }, maturity: { days_since_cohort_end: 30 } };
const act = (res, id) => res.recommendations.find((r) => r.campaign_id === id);

test('strong campaigns scale, weak ones reduce, middling ones hold - against the median', () => {
  const res = advise({ currency: 'INR', quality: mature, campaigns: [
    camp('star', { booked: 40000 }),    // 8x
    camp('okay', { booked: 10000 }),    // 2x
    camp('okay2', { booked: 12500 }),   // 2.5x
    camp('weak', { booked: 1000 }),     // 0.2x
  ] });
  assert.equal(res.median_return_on_spend, 2.25);
  assert.equal(act(res, 'star').action, 'scale');
  assert.equal(act(res, 'weak').action, 'reduce');
  assert.equal(act(res, 'okay').action, 'hold');
  assert.equal(res.applied_automatically, false);
  assert.match(res.disclaimer, /Nothing is changed/);
});

test('the suggested shift is bounded: at most 20% of a campaign, and what goes up equals what comes down', () => {
  const res = advise({ currency: 'INR', quality: mature, campaigns: [camp('star', { booked: 40000 }), camp('okay', { booked: 10000 }), camp('okay2', { booked: 12500 }), camp('weak', { booked: 1000, spend: 10000 })] });
  assert.equal(act(res, 'weak').suggested_change.amount, 2000);                       // 20% of 10000
  assert.equal(act(res, 'star').suggested_change.amount, 2000);                       // the only scale campaign gets the whole pool
  assert.deepEqual(res.shift, { currency: 'INR', amount: 2000, from: ['weak'], to: ['star'], note: res.shift.note });
  const total = res.recommendations.filter((r) => r.suggested_change && r.suggested_change.direction === 'increase').reduce((a, r) => a + r.suggested_change.amount, 0);
  assert.ok(Math.abs(total - res.shift.amount) < 0.02);
});

test('without enough evidence it says so instead of guessing', () => {
  const res = advise({ currency: 'INR', quality: mature, campaigns: [
    camp('tiny', { spend: 100 }), camp('fewleads', { leads: 5 }), camp('nodata', { spend: null }), camp('usd', { cur: 'USD' }),
    camp('few', { customers: 1 }),
  ] });
  assert.equal(act(res, 'tiny').action, 'insufficient_data'); assert.match(act(res, 'tiny').reason, /less than 2000/);
  assert.equal(act(res, 'fewleads').action, 'insufficient_data');
  assert.equal(act(res, 'nodata').action, 'insufficient_data');
  assert.equal(act(res, 'usd').action, 'insufficient_data'); assert.match(act(res, 'usd').reason, /different currency/);
  assert.equal(act(res, 'few').action, 'hold'); assert.equal(act(res, 'few').confidence, 'low');
  assert.ok(res.recommendations.every((r) => !['scale', 'reduce'].includes(r.action)));
});

test('a single comparable campaign cannot be ranked against nothing', () => {
  const res = advise({ currency: 'INR', quality: mature, campaigns: [camp('only', { booked: 90000 })] });
  assert.equal(res.median_return_on_spend, null); assert.equal(act(res, 'only').action, 'hold');
});

test('spending with no customers is a reduce only when the spend is large and the leads are old enough', () => {
  const big = camp('burn', { spend: 9000, customers: 0, booked: 0 });
  assert.equal(act(advise({ currency: 'INR', quality: mature, campaigns: [big] }), 'burn').action, 'reduce');
  assert.equal(act(advise({ currency: 'INR', quality: mature, campaigns: [camp('small', { spend: 3000, customers: 0, booked: 0 })] }), 'small').action, 'hold');
  const young = { attribution: { coverage_pct: 95 }, maturity: { days_since_cohort_end: 2 } };
  const y = advise({ currency: 'INR', quality: young, campaigns: [big] });
  assert.equal(act(y, 'burn').action, 'hold', 'a young cohort never triggers a cut');
  assert.match(y.warnings.join(' '), /keep arriving for weeks/);
});

test('poor attribution lowers every confidence and warns', () => {
  const res = advise({ currency: 'INR', quality: { attribution: { coverage_pct: 40 }, maturity: { days_since_cohort_end: 30 } },
    campaigns: [camp('star', { booked: 40000 }), camp('okay', { booked: 10000 }), camp('okay2', { booked: 12500 })] });
  assert.match(res.warnings[0], /Only 40%/);
  assert.ok(res.recommendations.filter((r) => r.confidence).every((r) => r.confidence === 'low'));
});

test('options are honoured and the campaign with no id (unattributed) is never ranked', () => {
  const res = advise({ currency: 'INR', quality: mature, options: { minSpend: 100 }, campaigns: [camp('tiny', { spend: 150, leads: 20, customers: 4 }), { ...camp('none'), campaign_id: null }] });
  assert.equal(res.recommendations.length, 1);
  assert.notEqual(act(res, 'tiny').action, 'insufficient_data');
  assert.equal(DEFAULTS.maxShiftPct, 20);
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('the advisor only reads: no query, no write, no ad API in the service', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/budgetAdvisor.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /require\(|query\(|UPDATE |INSERT |fetch\(|axios/);
});

test('the recommendations route is gated, administrator-only, read-only and does not touch the shadow log', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('routes/cohort.js'), /router\.get\('\/recommendations', requirePermission\('finance\.view'\), ctrl\.recommendations\)/);
  const ctl = read('controllers/cohortController.js');
  const body = ctl.slice(ctl.indexOf('const recommendations = async'), ctl.indexOf('// GET /api/cohort/health'));
  assert.match(body, /feature_off/); assert.match(body, /!isAdmin\(req\.user\)/);
  assert.doesNotMatch(body, /recordShadow|INSERT|UPDATE|DELETE/);
});
