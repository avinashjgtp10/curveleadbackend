// Budget suggestions (Phase 3). RULE-BASED and fully explainable: it reads the cohort metrics and says, per campaign, whether
// the evidence supports spending more, spending less, or waiting. It NEVER changes a budget, an ad account or any data - a person
// decides. Every suggestion carries the numbers behind it, and the guardrails below make it say "not enough evidence" rather
// than guess:
//   * one currency at a time, and only campaigns whose spend, bookings and revenue share that currency;
//   * a campaign needs real spend, enough leads and enough customers before it is ranked;
//   * results from recent leads are incomplete (customers and payments arrive later), so a young cohort can never trigger "reduce";
//   * poor campaign attribution lowers confidence for everything.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const DEFAULTS = {
  minSpend: 2000,          // per campaign, in the spend currency, over the period
  minLeads: 15,
  minCustomers: 3,         // needed before a campaign's return is trusted
  scaleFactor: 1.5,        // return at least this many times the median to be called strong
  reduceFactor: 0.5,       // return at most this fraction of the median to be called weak
  minCohortAgeDays: 14,    // "reduce" needs leads old enough to have converted
  maxShiftPct: 20,         // never suggest moving more than this share of a campaign's spend
  minAttributionPct: 70,
};

const amountIn = (list, currency) => ((list || []).find((x) => x.currency === currency) || {}).amount || 0;

// campaigns: the `campaigns` array from services/cohortMetrics (present()), quality: cohort.quality, totals: cohort.totals.
const advise = ({ campaigns, quality, currency, options = {} }) => {
  const o = { ...DEFAULTS, ...options };
  const warnings = [];
  const coverage = quality && quality.attribution ? quality.attribution.coverage_pct : null;
  const age = quality && quality.maturity ? quality.maturity.days_since_cohort_end : null;
  const young = age != null && age < o.minCohortAgeDays;
  if (coverage != null && coverage < o.minAttributionPct) warnings.push(`Only ${coverage}% of leads are linked to a campaign, so these suggestions may miss part of the picture.`);
  if (young) warnings.push(`This period ended ${age} day(s) ago. Customers and payments keep arriving for weeks, so nothing is suggested to be cut yet.`);

  const rows = (campaigns || []).filter((c) => c.campaign_id).map((c) => {
    const spend = c.spend && c.spend.currency === currency ? c.spend.amount : null;
    const booked = amountIn(c.booked, currency);
    const collected = amountIn(c.collected && c.collected.net, currency);
    const base = { campaign_id: c.campaign_id, campaign_name: c.campaign_name, leads: c.leads, customers: c.acquired, spend, booked, collected,
      return_on_spend: spend > 0 ? round2(booked / spend) : null };
    if (spend == null || !(spend > 0)) return { ...base, action: 'insufficient_data', reason: c.spend && c.spend.amount != null && c.spend.currency !== currency ? 'Spend is in a different currency.' : 'No ad spend data for this period.' };
    if (spend < o.minSpend) return { ...base, action: 'insufficient_data', reason: `Spent less than ${o.minSpend} in the period.` };
    if (c.leads < o.minLeads) return { ...base, action: 'insufficient_data', reason: `Fewer than ${o.minLeads} leads.` };
    return { ...base, eligible: true };
  });

  const ranked = rows.filter((r) => r.eligible && r.customers >= o.minCustomers);
  const med = ranked.length >= 2 ? median(ranked.map((r) => r.return_on_spend)) : null;
  const out = rows.map((r) => {
    if (!r.eligible) return r;
    const { eligible, ...x } = r;
    if (r.customers < o.minCustomers) {
      if (r.customers === 0 && r.spend >= o.minSpend * 3 && !young) return { ...x, action: 'reduce', confidence: 'low', reason: `Spent ${r.spend} and ${r.leads} leads produced no customers.` };
      return { ...x, action: 'hold', confidence: 'low', reason: `Fewer than ${o.minCustomers} customers so far, too few to judge the return.` };
    }
    if (med == null) return { ...x, action: 'hold', confidence: 'low', reason: 'Not enough comparable campaigns to rank against.' };
    if (r.return_on_spend >= med * o.scaleFactor && r.return_on_spend >= 1) return { ...x, action: 'scale', confidence: 'medium', reason: `Return of ${r.return_on_spend}× is ${round2(r.return_on_spend / med)}× the median (${round2(med)}×).` };
    if ((r.return_on_spend <= med * o.reduceFactor || r.return_on_spend < 1) && !young) return { ...x, action: 'reduce', confidence: 'medium', reason: `Return of ${r.return_on_spend}× is well below the median (${round2(med)}×).` };
    return { ...x, action: 'hold', confidence: 'medium', reason: `Return of ${r.return_on_spend}× is in line with the median (${round2(med)}×).` };
  });

  // Cap confidence when the underlying data is weak.
  const weak = (coverage != null && coverage < o.minAttributionPct) || young;
  for (const r of out) if (weak && r.confidence === 'medium') r.confidence = 'low';

  // A bounded shift: take up to maxShiftPct of each "reduce" campaign's spend and offer it to the "scale" campaigns by strength.
  const cut = out.filter((r) => r.action === 'reduce');
  const up = out.filter((r) => r.action === 'scale');
  let shift = null;
  if (cut.length && up.length) {
    const pool = round2(cut.reduce((a, r) => a + (r.spend * o.maxShiftPct) / 100, 0));
    const totalRoas = up.reduce((a, r) => a + r.return_on_spend, 0);
    for (const r of cut) r.suggested_change = { direction: 'decrease', amount: round2((r.spend * o.maxShiftPct) / 100), pct_of_spend: o.maxShiftPct };
    for (const r of up) r.suggested_change = { direction: 'increase', amount: round2((pool * r.return_on_spend) / totalRoas) };
    shift = { currency, amount: pool, from: cut.map((r) => r.campaign_id), to: up.map((r) => r.campaign_id), note: `At most ${o.maxShiftPct}% of a campaign's spend in one step. Review the results before moving more.` };
  } else if (cut.length) {
    for (const r of cut) r.suggested_change = { direction: 'decrease', amount: round2((r.spend * o.maxShiftPct) / 100), pct_of_spend: o.maxShiftPct };
  }

  const order = { scale: 0, reduce: 1, hold: 2, insufficient_data: 3 };
  out.sort((a, b) => order[a.action] - order[b.action] || (b.spend || 0) - (a.spend || 0));
  return {
    currency, applied_automatically: false, median_return_on_spend: med == null ? null : round2(med), options: o, warnings, shift, recommendations: out,
    disclaimer: 'Suggestions only. Nothing is changed in your ad accounts or budgets. Return on spend here is booked value divided by ad spend for leads created in the period.',
  };
};

module.exports = { advise, DEFAULTS, median };
