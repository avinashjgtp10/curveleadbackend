// Revenue over time for the Phase 2 dashboard. This is a CASH/BOOKING view by date (not a cohort): booked value is dated by
// the day the lead was booked (won), collected money by the day it was paid. Rules:
//   * never mixes currencies: every figure is per currency;
//   * only COMPLETED ledger entries count; refunds and reversals subtract; pending money is not collected;
//   * a payment with no known date is never put in a bucket - it is reported as `undated`, so totals stay honest;
//   * test leads are excluded; merged leads are not (money never changes owner on a merge).
const { query } = require('../config/db');
const { metricScope } = require('./metrics');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const NET = `CASE p.kind WHEN 'payment' THEN p.amount WHEN 'refund' THEN -p.amount WHEN 'reversal' THEN -p.amount
                          ELSE CASE p.adjustment_direction WHEN 'credit' THEN p.amount ELSE -p.amount END END`;

// Weekly for ranges up to 100 days, monthly beyond that.
const bucketFor = (from, to) => ((to.getTime() - from.getTime()) / 864e5 <= 100 ? 'week' : 'month');

const merge = (booked, collected) => {
  const rows = new Map();
  const at = (b) => { if (!rows.has(b)) rows.set(b, { bucket: b, booked: {}, collected: {} }); return rows.get(b); };
  for (const r of booked) { const o = at(r.bucket).booked; o[r.currency] = round2((o[r.currency] || 0) + Number(r.amount)); }
  for (const r of collected) { const o = at(r.bucket).collected; o[r.currency] = round2((o[r.currency] || 0) + Number(r.amount)); }
  return [...rows.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
};

async function getTimeline(req) {
  const scope = await metricScope(req);
  const bucket = bucketFor(scope.from, scope.to);
  const tz = scope.tz || 'Asia/Kolkata';
  const testLead = `NOT COALESCE((to_jsonb(l)->>'is_test_lead')::boolean, false)`;
  const [booked, collected, undated] = await Promise.all([
    query(`SELECT to_char(date_trunc('${bucket}', l.booked_at AT TIME ZONE $4::text), 'YYYY-MM-DD') AS bucket, v.currency, sum(v.value) AS amount
           FROM leads l JOIN v_lead_booked v ON v.lead_id = l.id AND v.tenant_id = l.tenant_id
           WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL AND ${testLead} AND v.value IS NOT NULL AND v.currency IS NOT NULL
             AND l.booked_at >= $2::timestamptz AND l.booked_at < $3::timestamptz
           GROUP BY 1, 2`, [scope.workspaceId, scope.from, scope.to, tz]),
    query(`SELECT to_char(date_trunc('${bucket}', COALESCE(p.paid_on, p.estimated_paid_on)::timestamp), 'YYYY-MM-DD') AS bucket, p.currency, sum(${NET}) AS amount
           FROM lead_payments p JOIN leads l ON l.id = p.lead_id
           WHERE p.tenant_id = $1 AND p.status = 'completed' AND ${testLead} AND COALESCE(p.paid_on, p.estimated_paid_on) IS NOT NULL
             AND COALESCE(p.paid_on, p.estimated_paid_on) >= (($2::timestamptz) AT TIME ZONE $4::text)::date AND COALESCE(p.paid_on, p.estimated_paid_on) < (($3::timestamptz) AT TIME ZONE $4::text)::date
           GROUP BY 1, 2`, [scope.workspaceId, scope.from, scope.to, tz]),
    query(`SELECT p.currency, sum(${NET}) AS amount, count(*)::int AS entries
           FROM lead_payments p JOIN leads l ON l.id = p.lead_id
           WHERE p.tenant_id = $1 AND p.status = 'completed' AND ${testLead} AND COALESCE(p.paid_on, p.estimated_paid_on) IS NULL
           GROUP BY 1`, [scope.workspaceId]),
  ]);
  return {
    from: scope.from.toISOString(), to: scope.to.toISOString(), bucket, timezone: tz,
    series: merge(booked.rows, collected.rows),
    undated: undated.rows.map((r) => ({ currency: r.currency, amount: round2(r.amount), entries: r.entries })),
    notes: {
      booked: 'Dated by the day the lead was booked (first Won). Includes audited corrections.',
      collected: 'Completed payments minus refunds and reversals, dated by the day paid (or the estimated day). Pending money is not included.',
      undated: 'Completed payments with no known date, across all time. They are not part of any period.',
    },
  };
}

module.exports = { getTimeline, bucketFor, merge, NET };
