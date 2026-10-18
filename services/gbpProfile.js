// Google Business Profile: how complete is a listing, and what do the insights say. PURE (no network, no database).
// Honest limits: this is a COMPLETENESS checklist built from the factors Google documents for local results. It does not
// know, predict or promise a position in Google Maps - Google exposes no ranking data through these APIs.
const round1 = (n) => Math.round(n * 10) / 10;

// Each check: weight (sums to 100), pass test, why it matters, what to do. `unknown` when Google did not tell us.
const CHECKS = [
  { id: 'primary_category', weight: 15, label: 'Main category', test: (d) => !!d.primary_category, why: 'The main category is the strongest signal for which searches show your business.', fix: 'Set the most specific main category that describes what you do.' },
  { id: 'additional_categories', weight: 8, label: 'Extra categories', test: (d) => d.additional_categories.length >= 1, why: 'Extra categories let you appear for related searches.', fix: 'Add one to three more categories that truly apply.' },
  { id: 'description', weight: 12, label: 'Business description', test: (d) => !!d.description && d.description.trim().length >= 250, why: 'A clear description (aim for 250+ characters) helps people and Google understand what you offer.', fix: 'Write 250 to 750 characters about your services and area, without promotions or links.' },
  { id: 'phone', weight: 10, label: 'Phone number', test: (d) => !!d.phone, why: 'Customers call from the listing, and a matching number builds trust.', fix: 'Add your main phone number.' },
  { id: 'website', weight: 10, label: 'Website', test: (d) => !!d.website, why: 'A website link sends visitors to book or enquire.', fix: 'Add your website address.' },
  { id: 'address', weight: 12, label: 'Complete address', test: (d) => !!(d.address && d.address.lines.length && d.address.locality && d.address.postal_code), why: 'A full address is needed to appear on the map and in "near me" results.', fix: 'Fill in street, city and postal code exactly as customers know it.' },
  { id: 'hours', weight: 13, label: 'Opening hours', test: (d) => d.open_days.length >= 1, why: 'Listings with hours are shown as open or closed, and can be filtered by "open now".', fix: 'Add your regular opening hours for every day.' },
  { id: 'verified', weight: 20, label: 'Verified listing', test: (d) => d.verified === true, unknownWhen: (d) => d.verified == null, why: 'Only a verified listing can be managed fully and shown with confidence.', fix: 'Verify the listing in Google Business Profile.' },
];

const profileHealth = (details) => {
  const d = { address: { lines: [] }, additional_categories: [], open_days: [], ...(details || {}) };
  d.address = { lines: [], ...(d.address || {}) };
  let earned = 0; let known = 0;
  const checks = CHECKS.map((c) => {
    const unknown = !!(c.unknownWhen && c.unknownWhen(d));
    const ok = unknown ? null : !!c.test(d);
    if (!unknown) { known += c.weight; if (ok) earned += c.weight; }
    return { id: c.id, label: c.label, weight: c.weight, ok, why: c.why, fix: ok ? null : c.fix };
  });
  const score = known ? Math.round((earned / known) * 100) : null;   // score only over what Google actually told us
  return {
    score, band: score == null ? 'unknown' : score >= 85 ? 'strong' : score >= 60 ? 'fair' : 'weak',
    checks, to_fix: checks.filter((c) => c.ok === false).sort((a, b) => b.weight - a.weight),
    note: 'A completeness checklist, not a ranking. Google does not publish your position.',
  };
};

// Raw fetchMultiDailyMetricsTimeSeries rows -> totals and a per-day series. Missing days/values are 0 (Google omits zeros).
const summarizeInsights = (rows, { from, to } = {}) => {
  const num = (v) => Number(v) || 0;
  const key = (dt) => `${dt.year}-${String(dt.month).padStart(2, '0')}-${String(dt.day).padStart(2, '0')}`;
  const byMetric = {}; const days = new Map();
  for (const r of rows || []) for (const s of r.dailyMetricTimeSeries || []) {
    const m = s.dailyMetric; byMetric[m] = byMetric[m] || 0;
    for (const v of (s.timeSeries && s.timeSeries.datedValues) || []) {
      const x = num(v.value); byMetric[m] += x;
      const k = key(v.date); const row = days.get(k) || { date: k }; row[m] = (row[m] || 0) + x; days.set(k, row);
    }
  }
  const sum = (names) => names.reduce((a, n) => a + (byMetric[n] || 0), 0);
  const maps = sum(['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS']);
  const search = sum(['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH']);
  const views = maps + search;
  const actions = { calls: byMetric.CALL_CLICKS || 0, website_clicks: byMetric.WEBSITE_CLICKS || 0, directions: byMetric.BUSINESS_DIRECTION_REQUESTS || 0 };
  const total_actions = actions.calls + actions.website_clicks + actions.directions;
  const series = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
    date: r.date,
    views: (r.BUSINESS_IMPRESSIONS_DESKTOP_MAPS || 0) + (r.BUSINESS_IMPRESSIONS_MOBILE_MAPS || 0) + (r.BUSINESS_IMPRESSIONS_DESKTOP_SEARCH || 0) + (r.BUSINESS_IMPRESSIONS_MOBILE_SEARCH || 0),
    actions: (r.CALL_CLICKS || 0) + (r.WEBSITE_CLICKS || 0) + (r.BUSINESS_DIRECTION_REQUESTS || 0),
  }));
  return {
    from: from || null, to: to || null, views: { total: views, maps, search }, actions: { ...actions, total: total_actions },
    action_rate_pct: views ? round1((total_actions / views) * 100) : null, series,
    note: 'Views are how often your listing was shown. Actions are calls, website clicks and direction requests from it.',
  };
};

module.exports = { profileHealth, summarizeInsights, CHECKS };
