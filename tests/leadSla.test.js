const assert = require('assert');
const { computeLeadSla } = require('../utils/leadSla');

const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

function run(name, fn) {
  fn();
  console.log(`ok - ${name}`);
}

run('1 min elapsed, uncontacted -> new', () => {
  const r = computeLeadSla({ created_at: minutesAgo(1), first_response_at: null });
  assert.strictEqual(r.sla_status, 'new');
  assert.strictEqual(r.is_uncontacted, true);
  assert.strictEqual(r.is_escalated, false);
});

run('exactly 5 min elapsed -> sla_risk (boundary inclusive)', () => {
  const r = computeLeadSla({ created_at: minutesAgo(5), first_response_at: null });
  assert.strictEqual(r.sla_status, 'sla_risk');
});

run('10 min elapsed -> sla_risk', () => {
  const r = computeLeadSla({ created_at: minutesAgo(10), first_response_at: null });
  assert.strictEqual(r.sla_status, 'sla_risk');
});

run('exactly 15 min elapsed -> sla_breached, escalated', () => {
  const r = computeLeadSla({ created_at: minutesAgo(15), first_response_at: null });
  assert.strictEqual(r.sla_status, 'sla_breached');
  assert.strictEqual(r.is_escalated, true);
});

run('100 min elapsed -> sla_breached', () => {
  const r = computeLeadSla({ created_at: minutesAgo(100), first_response_at: null });
  assert.strictEqual(r.sla_status, 'sla_breached');
});

run('exactly 1440 min (24h) elapsed -> missed_lead', () => {
  const r = computeLeadSla({ created_at: minutesAgo(1440), first_response_at: null });
  assert.strictEqual(r.sla_status, 'missed_lead');
});

run('3000 min elapsed -> missed_lead', () => {
  const r = computeLeadSla({ created_at: minutesAgo(3000), first_response_at: null });
  assert.strictEqual(r.sla_status, 'missed_lead');
});

run('contacted always wins regardless of elapsed time', () => {
  const r = computeLeadSla({ created_at: minutesAgo(5000), first_response_at: minutesAgo(1) });
  assert.strictEqual(r.sla_status, 'contacted');
  assert.strictEqual(r.is_uncontacted, false);
  assert.strictEqual(r.is_escalated, false);
});

run('minutes_to_breach sanity check for the new bucket', () => {
  const r = computeLeadSla({ created_at: minutesAgo(2), first_response_at: null });
  assert.strictEqual(r.minutes_to_breach, 3);
});

console.log('All leadSla tests passed.');
