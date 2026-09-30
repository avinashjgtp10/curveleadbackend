const { query } = require('../config/db');
async function metricScope(req) {
  const tenant = await query('SELECT settings FROM tenants WHERE id=$1', [req.tenantId]);
  const tz = tenant.rows[0]?.settings?.timezone || 'Asia/Kolkata';
  const { period = 'this_month', from, to, date_from, date_to } = req.query;
  let start, end;
  if (from || to) {
    if (!from || !to || !/(Z|[+-]\d{2}:\d{2})$/.test(from) || !/(Z|[+-]\d{2}:\d{2})$/.test(to)) throw Object.assign(new Error('from and to must be UTC/offset timestamps; to is exclusive.'), { status: 422 });
    start = new Date(from); end = new Date(to);
  } else {
    const units = { today: 'day', this_week: 'week', this_month: 'month', last_month: 'month', this_year: 'year' };
    if (period === 'custom') {
      if (![date_from, date_to].every(v => /^\d{4}-\d{2}-\d{2}$/.test(v || ''))) throw Object.assign(new Error('Provide date_from and date_to.'), { status: 422 });
      const r = await query("SELECT $1::date::timestamp AT TIME ZONE $3 AS start, ($2::date + 1)::timestamp AT TIME ZONE $3 AS end", [date_from, date_to, tz]);
      ({ start, end } = r.rows[0]);
    } else {
      const unit = units[period] || 'month';
      const r = await query(`SELECT (date_trunc($1, now() AT TIME ZONE $2) - $3::interval) AT TIME ZONE $2 AS start, (date_trunc($1, now() AT TIME ZONE $2) - $3::interval + $4::interval) AT TIME ZONE $2 AS end`,
        [unit, tz, period === 'last_month' ? '1 month' : '0 days', `1 ${unit}`]);
      ({ start, end } = r.rows[0]);
    }
  }
  start = new Date(start); end = new Date(end);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || start >= end) throw Object.assign(new Error('Invalid metric period.'), { status: 422 });
  return { workspaceId: req.tenantId, from: start, to: end, staffId: req.user.role === 'staff' ? req.user.id : null };
}
// One row per lead: a lead entering Won twice still counts once in a selected period.
// History remains authoritative after reopening. Legacy won_at is used only if no Won history exists.
const BASE = `WITH scoped AS (
 SELECT l.*, (l.created_at >= $2 AND l.created_at < $3) AS in_period,
 (EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.tenant_id=l.tenant_id AND h.lead_id=l.id
    AND lower(trim(h.new_stage))='won' AND lower(trim(COALESCE(h.prev_stage,''))) <> 'won' AND h.changed_at >= $2 AND h.changed_at < $3)
  OR (lower(trim(l.stage))='won' AND l.won_at >= $2 AND l.won_at < $3 AND NOT EXISTS
    (SELECT 1 FROM lead_stage_history h WHERE h.tenant_id=l.tenant_id AND h.lead_id=l.id AND lower(trim(h.new_stage))='won'))) AS won_in_period
 FROM leads l WHERE l.tenant_id=$1 AND ($4::uuid IS NULL OR l.assigned_to=$4)
)`;
const COUNTS = `COUNT(*) FILTER (WHERE in_period)::int AS total_leads,
 COUNT(*) FILTER (WHERE won_in_period)::int AS won,
 COUNT(*) FILTER (WHERE in_period AND lower(trim(stage))='lost')::int AS lost,
 COUNT(*) FILTER (WHERE in_period AND lead_score='hot')::int AS hot_leads,
 COUNT(*) FILTER (WHERE in_period AND assigned_to IS NULL)::int AS unassigned,
 COALESCE(SUM(deal_value) FILTER (WHERE won_in_period),0)::float AS revenue`;
const params = s => [s.workspaceId,s.from,s.to,s.staffId || null];
const rate = row => ({ ...row, conversion_rate: row.total_leads > 0 ? Number((row.won / row.total_leads * 100).toFixed(1)) : 0 });
async function getMetrics(scope) {
  const r = await query(`${BASE} SELECT ${COUNTS},
    (SELECT COUNT(*)::int FROM campaigns c WHERE c.tenant_id=$1 AND lower(c.status)='active'
      AND c.created_at < $3 AND (c.start_date IS NULL OR c.start_date < $3::date) AND (c.end_date IS NULL OR c.end_date >= $2::date)) AS active_campaigns
    FROM scoped`, params(scope));
  return { ...rate(r.rows[0]), from: scope.from.toISOString(), to: scope.to.toISOString() };
}
async function getBreakdown(scope, dimension) {
  if (!['source','assigned_to','campaign_id'].includes(dimension)) throw new Error('Invalid metric dimension');
  const r = await query(`${BASE} SELECT ${dimension === 'source' ? "CASE WHEN lower(trim(source)) IN ('facebook','facebook_ads','meta') THEN 'meta_ads' ELSE lower(replace(trim(COALESCE(source,'manual')), ' ', '_')) END" : dimension} AS ${dimension}, ${COUNTS} FROM scoped WHERE in_period OR won_in_period GROUP BY 1 ORDER BY total_leads DESC`, params(scope));
  return r.rows.map(rate);
}
const getLeadCounts = getMetrics;
const getWonCount = async s => (await getMetrics(s)).won;
const getConversionRate = async s => (await getMetrics(s)).conversion_rate;
const getUnassignedCount = async s => (await getMetrics(s)).unassigned;
const getActiveCampaigns = async s => (await getMetrics(s)).active_campaigns;
module.exports = { metricScope, getMetrics, getBreakdown, getLeadCounts, getWonCount, getConversionRate, getUnassignedCount, getActiveCampaigns };
