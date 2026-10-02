// Pure helpers that turn Meta Insights rows into ad_insights_daily values.

// Meta reports the same lead under several action types (e.g. "lead" and
// "onsite_conversion.lead_grouped" for the same Lead Ads submission). Take the
// first one present, in this order, so a lead is never counted twice.
const LEAD_ACTION_TYPES = [
  'lead',
  'onsite_conversion.lead_grouped',
  'leadgen_grouped',
  'offsite_conversion.fb_pixel_lead',
  'onsite_web_lead',
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const pickAction = (list, types = LEAD_ACTION_TYPES) => {
  if (!Array.isArray(list)) return null;
  for (const type of types) {
    const found = list.find((a) => a && a.action_type === type);
    if (found) return found;
  }
  return null;
};

const round = (n, dp) => (n === null ? null : Number(n.toFixed(dp)));

/**
 * @param {object} row  one Insights row (strings, as Meta returns them)
 * @returns {{date, spend, impressions, clicks, ctr, cpc, leads, cpl, actions, cost_per_action_type}}
 */
const parseInsightsRow = (row = {}) => {
  const spend = num(row.spend);
  const impressions = Math.round(num(row.impressions));
  const clicks = Math.round(num(row.clicks));
  const leadAction = pickAction(row.actions);
  const leads = leadAction ? Math.round(num(leadAction.value)) : 0;
  const costAction = leadAction ? pickAction(row.cost_per_action_type, [leadAction.action_type]) : null;

  // Prefer Meta's own figures; recompute when absent so rolled-up rows match.
  const ctr = row.ctr !== undefined && row.ctr !== '' ? num(row.ctr) : impressions ? (clicks / impressions) * 100 : null;
  const cpc = row.cpc !== undefined && row.cpc !== '' ? num(row.cpc) : clicks ? spend / clicks : null;
  const cpl = costAction ? num(costAction.value) : leads ? spend / leads : null;

  return {
    date: row.date_start || null,
    spend: round(spend, 2),
    impressions,
    clicks,
    ctr: round(ctr, 4),
    cpc: round(cpc, 4),
    leads,
    cpl: round(cpl, 2),
    actions: Array.isArray(row.actions) ? row.actions : null,
    cost_per_action_type: Array.isArray(row.cost_per_action_type) ? row.cost_per_action_type : null,
  };
};

// Meta budgets are in minor units (paise for INR) as strings; null when unset.
const parseBudgetPaise = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

module.exports = { LEAD_ACTION_TYPES, parseInsightsRow, parseBudgetPaise, pickAction };
