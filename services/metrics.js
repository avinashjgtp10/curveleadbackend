const { query } = require('../config/db');
const { localeFromSettings } = require('../utils/workspaceLocale');

// ONE definition of lead / spend / conversion metrics, used by every screen (Batch 1 A):
// dashboard, pipeline, Campaigns tab + campaign detail, Meta Ads dashboard, Reports, playbook.
//
//   crm_leads         leads created in [from, to) — live (not merged), staff-scoped
//   won               WON THIS PERIOD (event): leads that entered a won stage in [from, to),
//                     whenever they were created. Shown separately and labelled.
//   converted         COHORT: of crm_leads, those that reached a won stage (any time so far)
//   qualified         COHORT: of crm_leads, those that reached a qualified or won stage
//   lost              COHORT: of crm_leads, currently in a lost stage
//   conversion_rate   converted / crm_leads (%), weighted
//   spend             ad spend in the range from daily insights, in the ad account currency
//   platform_leads    leads the ad platform reports for the range ("Reported by Meta")
//   cpl               spend / crm_leads                (cohort)
//   cost_per_customer spend / converted                (cohort)
//   platform_cpl      spend / platform_leads
//   revenue           deal value of leads won this period
// "Won" / "qualified" / "lost" are the workspace's stage flags (lead_stages.is_won /
// is_qualified / is_lost) — never a stage name. Campaigns without daily insights (manual)
// have no period spend: spend/cpl are null and spend_basis says why. Spend in different
// currencies is never added up (spend_by_currency instead).

async function metricScope(req) {
  const tenant = await query('SELECT settings FROM tenants WHERE id=$1', [req.tenantId]);
  const tz = localeFromSettings(tenant.rows[0]?.settings || {}).timezone;
  const { period = 'this_month', from, to, date_from, date_to } = req.query;
  let start, end;
  if (period === 'lifetime') {
    start = new Date('2000-01-01T00:00:00Z'); end = new Date(Date.now() + 864e5);
  } else if (from || to) {
    if (!from || !to || !/(Z|[+-]\d{2}:\d{2})$/.test(from) || !/(Z|[+-]\d{2}:\d{2})$/.test(to)) throw Object.assign(new Error('from and to must be UTC/offset timestamps; to is exclusive.'), { status: 422 });
    start = new Date(from); end = new Date(to);
  } else if (/^last_(7|30|90)_days$/.test(period)) {
    const r = await query(`SELECT (date_trunc('day', now() AT TIME ZONE $1) - ($2::int - 1) * interval '1 day') AT TIME ZONE $1 AS start,
                                  (date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1 AS end`, [tz, Number(period.match(/\d+/)[0])]);
    ({ start, end } = r.rows[0]);
  } else if (period === 'custom') {
    if (![date_from, date_to].every(v => /^\d{4}-\d{2}-\d{2}$/.test(v || ''))) throw Object.assign(new Error('Provide date_from and date_to.'), { status: 422 });
    const r = await query("SELECT $1::date::timestamp AT TIME ZONE $3 AS start, ($2::date + 1)::timestamp AT TIME ZONE $3 AS end", [date_from, date_to, tz]);
    ({ start, end } = r.rows[0]);
  } else {
    const units = { today: 'day', this_week: 'week', this_month: 'month', last_month: 'month', this_year: 'year' };
    const unit = units[period] || 'month';
    const r = await query(`SELECT (date_trunc($1, now() AT TIME ZONE $2) - $3::interval) AT TIME ZONE $2 AS start, (date_trunc($1, now() AT TIME ZONE $2) - $3::interval + $4::interval) AT TIME ZONE $2 AS end`,
      [unit, tz, period === 'last_month' ? '1 month' : '0 days', `1 ${unit}`]);
    ({ start, end } = r.rows[0]);
  }
  start = new Date(start); end = new Date(end);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || start >= end) throw Object.assign(new Error('Invalid metric period.'), { status: 422 });
  return { workspaceId: req.tenantId, from: start, to: end, tz, staffId: req.user.role === 'staff' ? req.user.id : null };
}

// The workspace's stage names with a flag, as a SQL list (lower-cased). Needs alias l.
const stageSet = (flagSql) => `(SELECT lower(trim(s.name)) FROM lead_stages s WHERE s.tenant_id = l.tenant_id AND ${flagSql})`;
const WON = stageSet('s.is_won');
const QUALIFIED = stageSet('(COALESCE(s.is_qualified, false) OR s.is_won)');
const LOST = stageSet('s.is_lost');

// Lead l entered a won stage within [from, to): history (from a non-won stage) is
// authoritative; a lead with no won history but a won current stage uses won_at.
const wonPredicate = (from, to) => `(EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.tenant_id=l.tenant_id AND h.lead_id=l.id
    AND lower(trim(h.new_stage)) IN ${WON} AND lower(trim(COALESCE(h.prev_stage,''))) NOT IN ${WON} AND h.changed_at >= ${from} AND h.changed_at < ${to})
  OR (lower(trim(l.stage)) IN ${WON} AND l.won_at >= ${from} AND l.won_at < ${to} AND NOT EXISTS
    (SELECT 1 FROM lead_stage_history h WHERE h.tenant_id=l.tenant_id AND h.lead_id=l.id AND lower(trim(h.new_stage)) IN ${WON})))`;
// Lead l has ever reached a stage in `set` (history or current stage).
const reached = (set) => `(lower(trim(l.stage)) IN ${set} OR EXISTS (SELECT 1 FROM lead_stage_history h
    WHERE h.tenant_id=l.tenant_id AND h.lead_id=l.id AND lower(trim(h.new_stage)) IN ${set}))`;

// $1 workspace, $2 from, $3 to, $4 staff (nullable), $5 attributed-only, $6 campaign ids (nullable)
const BASE = `WITH scoped AS (
 SELECT l.id, l.campaign_id, l.source, l.assigned_to, l.lead_score, l.deal_value,
   (l.created_at >= $2 AND l.created_at < $3) AS in_period,
   ${wonPredicate('$2', '$3')} AS won_in_period,
   ${reached(WON)} AS ever_won,
   ${reached(QUALIFIED)} AS ever_qualified,
   lower(trim(l.stage)) IN ${LOST} AS is_lost_now
 FROM leads l
 WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL AND ($4::uuid IS NULL OR l.assigned_to = $4)
   AND (NOT $5::boolean OR l.campaign_id IS NOT NULL) AND ($6::uuid[] IS NULL OR l.campaign_id = ANY($6::uuid[]))
)`;
const COUNTS = `COUNT(*) FILTER (WHERE in_period)::int AS crm_leads,
 COUNT(*) FILTER (WHERE won_in_period)::int AS won,
 COUNT(*) FILTER (WHERE in_period AND ever_won)::int AS converted,
 COUNT(*) FILTER (WHERE in_period AND ever_qualified)::int AS qualified,
 COUNT(*) FILTER (WHERE in_period AND is_lost_now)::int AS lost,
 COUNT(*) FILTER (WHERE in_period AND lead_score='hot')::int AS hot_leads,
 COUNT(*) FILTER (WHERE in_period AND assigned_to IS NULL)::int AS unassigned,
 COALESCE(SUM(deal_value) FILTER (WHERE won_in_period),0)::float AS revenue`;

const DIMENSIONS = {
  source: "CASE WHEN lower(trim(source)) IN ('facebook','facebook_ads','meta') THEN 'meta_ads' ELSE lower(replace(trim(COALESCE(source,'manual')), ' ', '_')) END",
  assigned_to: 'assigned_to',
  campaign_id: 'campaign_id',
};

const day = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata' }).format(d);

// Spend + platform-reported leads per CRM campaign for the range, from daily insights.
const adSpend = async (scope, campaignIds = null) => {
  const r = await query(
    `SELECT ac.campaign_id, a.currency, COALESCE(sum(i.spend), 0)::float AS spend, COALESCE(sum(i.leads), 0)::int AS platform_leads
     FROM ad_campaigns ac JOIN ad_accounts a ON a.id = ac.ad_account_id AND a.tenant_id = ac.tenant_id
     LEFT JOIN ad_insights_daily i ON i.tenant_id = ac.tenant_id AND i.entity_type = 'campaign' AND i.entity_id = ac.external_id
       AND i.date BETWEEN $2::date AND $3::date
     WHERE ac.tenant_id = $1 AND ac.campaign_id IS NOT NULL AND ($4::uuid[] IS NULL OR ac.campaign_id = ANY($4::uuid[]))
     GROUP BY ac.campaign_id, a.currency`,
    [scope.workspaceId, day(scope.from, scope.tz), day(new Date(scope.to.getTime() - 1), scope.tz), campaignIds]
  ).catch((e) => { if (['42P01', '42703'].includes(e.code)) return { rows: [] }; throw e; });
  return r.rows;
};

const ratio = (a, b) => (b > 0 && a != null ? Number((a / b).toFixed(2)) : null);

// Adds rates + spend-based figures to a counts row. spendRows: ad spend rows for this group.
const derive = (row, spendRows = []) => {
  const currencies = [...new Set(spendRows.map(s => s.currency).filter(Boolean))];
  const measured = spendRows.length > 0;
  const sum = (rows, k) => rows.reduce((t, s) => t + (Number(s[k]) || 0), 0);
  // Never add up different currencies without FX: report per currency instead.
  const spend = measured && currencies.length <= 1 ? Number(sum(spendRows, 'spend').toFixed(2)) : null;
  const platformLeads = measured ? sum(spendRows, 'platform_leads') : null;
  return {
    ...row,
    total_leads: row.crm_leads,                                   // legacy name, same number
    conversion_rate: row.crm_leads > 0 ? Number(((row.converted / row.crm_leads) * 100).toFixed(1)) : 0,
    spend,
    currency: currencies.length === 1 ? currencies[0] : null,
    spend_by_currency: currencies.length > 1
      ? Object.fromEntries(currencies.map(c => [c, Number(sum(spendRows.filter(s => s.currency === c), 'spend').toFixed(2))])) : null,
    spend_basis: !measured ? 'not_measured' : currencies.length > 1 ? 'mixed_currencies' : 'daily_insights',
    platform_leads: platformLeads,
    cpl: ratio(spend, row.crm_leads),
    cost_per_customer: ratio(spend, row.converted),
    platform_cpl: ratio(spend, platformLeads),
  };
};

const params = (s, { attributedOnly = false, campaignIds = null } = {}) =>
  [s.workspaceId, s.from, s.to, s.staffId || null, !!attributedOnly, campaignIds && campaignIds.length ? campaignIds : null];

// Workspace totals (or attributed-only / selected campaigns).
async function getMetrics(scope, opts = {}) {
  const r = await query(`${BASE} SELECT ${COUNTS} FROM scoped`, params(scope, opts));
  const spendRows = await adSpend(scope, opts.campaignIds || null);
  return {
    ...derive(r.rows[0], spendRows),
    active_campaigns: await activeCampaigns(scope),
    from: scope.from.toISOString(), to: scope.to.toISOString(),
  };
}

// Per-dimension rows (source / assigned_to / campaign_id). Campaign rows carry spend.
async function getBreakdown(scope, dimension, opts = {}) {
  if (!DIMENSIONS[dimension]) throw new Error('Invalid metric dimension');
  const r = await query(
    `${BASE} SELECT ${DIMENSIONS[dimension]} AS ${dimension}, ${COUNTS} FROM scoped WHERE in_period OR won_in_period GROUP BY 1 ORDER BY crm_leads DESC`,
    params(scope, opts));
  if (dimension !== 'campaign_id') return r.rows.map(row => derive(row));
  const spend = await adSpend(scope, opts.campaignIds || null);
  const rows = new Map(r.rows.map(row => [row.campaign_id, row]));
  // Campaigns with spend but no leads in the range still appear (spend, 0 leads).
  for (const s of spend) {
    if (!rows.has(s.campaign_id)) rows.set(s.campaign_id, { campaign_id: s.campaign_id, crm_leads: 0, won: 0, converted: 0, qualified: 0, lost: 0, hot_leads: 0, unassigned: 0, revenue: 0 });
  }
  return [...rows.values()].map(row => derive(row, spend.filter(s => s.campaign_id === row.campaign_id)));
}

// One definition of "active campaign": CRM campaign status active.
async function activeCampaigns(scope) {
  return (await query("SELECT COUNT(*)::int AS n FROM campaigns WHERE tenant_id = $1 AND lower(status) = 'active'", [scope.workspaceId])).rows[0].n;
}

const getLeadCounts = getMetrics;
const getWonCount = async s => (await getMetrics(s)).won;
const getConversionRate = async s => (await getMetrics(s)).conversion_rate;
const getUnassignedCount = async s => (await getMetrics(s)).unassigned;
const getActiveCampaigns = activeCampaigns;
module.exports = {
  wonPredicate, reached, WON, QUALIFIED, LOST, metricScope, getMetrics, getBreakdown, activeCampaigns, adSpend, derive,
  getLeadCounts, getWonCount, getConversionRate, getUnassignedCount, getActiveCampaigns,
};
