// Cohort reporting (Phase 1). The unit is the LEAD CREATION cohort: leads created in [from, to) and everything that
// happened to them afterwards (qualified, won, paid), so a cohort's numbers keep maturing as customers convert and pay.
// Reads the milestone events, the booked-value snapshot, the payment ledger and the existing daily ad spend. There is no
// second spend engine: metricScope / adSpend / getMetrics are reused from services/metrics.js.
//
// Money rules
//  * Currencies are NEVER mixed. A ratio is computed only when the spend and every revenue amount it uses share one
//    currency; otherwise it is null with a reason, and the per-currency amounts are returned.
//  * Zero spend, zero leads, zero customers each return null with their own reason, never Infinity or 0.
//  * A campaign with no spend rows is "not measured", not zero. Unattributed leads get their own row without spend.
//  * Cancelled customers are counted separately; "acquired" is never decremented.
//  * Collected revenue is NET (completed payments - refunds - reversals +/- adjustments) on every cohort lead, including
//    leads not yet Won, which are reported on their own line. A merged lead's money counts at its root. Pending is shown,
//    never counted. Payment dates are reported by basis (confirmed / estimated / unknown), never blended silently.
const { query } = require('../config/db');
const { metricScope, adSpend, getMetrics } = require('./metrics');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;

const REQUIRED_OBJECTS = [
  ['lead_milestone_events', 'models/migration_phase1_milestones.sql'],
  ['lead_attribution', 'models/migration_phase1_attribution.sql'],
  ['lead_payments', 'models/migration_phase1_lead_payments.sql'],
  ['v_lead_booked', 'models/migration_phase1_booking.sql'],
];

const missingObjects = async () => {
  const missing = [];
  for (const [name, file] of REQUIRED_OBJECTS) {
    const r = await query('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
    if (!r.rows[0].present) missing.push({ object: name, migration: file });
  }
  return missing;
};

// ---- pure: ratios with currency safeguards -----------------------------------------------------------------------------------
// spend: { measured, byCurrency: { INR: 10000 } }   booked / collected: { INR: 20000 }
const computeRatios = ({ leads, qualified, acquired, spend, booked = {}, collected = {} }) => {
  const out = {};
  const set = (key, value, reason = null) => { out[key] = { value, reason }; };
  const spendCurrencies = Object.keys(spend.byCurrency || {});

  let spendValue = null; let spendCurrency = null; let spendReason = null;
  if (!spend.measured || spendCurrencies.length === 0) spendReason = 'not_measured';
  else if (spendCurrencies.length > 1) spendReason = 'mixed_spend_currencies';
  else { spendCurrency = spendCurrencies[0]; spendValue = round2(spend.byCurrency[spendCurrency]); if (spendValue <= 0) spendReason = 'no_spend'; }

  const perUnit = (key, count, noCountReason) => {
    if (spendReason) return set(key, null, spendReason);
    if (!count) return set(key, null, noCountReason);
    return set(key, round2(spendValue / count));
  };
  perUnit('cpl', leads, 'no_leads');
  perUnit('cost_per_qualified', qualified, 'no_qualified');
  perUnit('cac', acquired, 'no_customers');

  const revenueRatio = (key, amounts, fn) => {
    if (spendReason) return set(key, null, spendReason);
    const foreign = Object.keys(amounts).filter((c) => c !== spendCurrency && num(amounts[c]) !== 0);
    if (foreign.length) return set(key, null, 'currency_mismatch');
    return set(key, fn(num(amounts[spendCurrency])));
  };
  revenueRatio('booked_roas', booked, (rev) => round2(rev / spendValue));
  revenueRatio('collected_roas', collected, (rev) => round2(rev / spendValue));
  revenueRatio('advertising_roi_pct', collected, (rev) => round2(((rev - spendValue) / spendValue) * 100));
  return { ratios: out, spend: spendValue, spend_currency: spendCurrency, spend_reason: spendReason };
};

// ---- queries ---------------------------------------------------------------------------------------------------------------------------
const hasTestFlag = async () => (await query(
  `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'leads' AND column_name = 'is_test_lead'`)).rows.length > 0;

const cohortRows = async (scope, { campaignIds = null } = {}) => {
  const testFilter = (await hasTestFlag()) ? 'AND NOT COALESCE(l.is_test_lead, false)' : '';
  const base = `WITH cohort AS (
      SELECT l.id, COALESCE(a.effective_crm_campaign_id, l.campaign_id) AS campaign_id, a.status AS attribution_status, lower(trim(l.stage)) AS stage_lc
      FROM leads l LEFT JOIN lead_attribution a ON a.lead_id = l.id AND a.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL AND l.created_at >= $2 AND l.created_at < $3 ${testFilter}
        AND ($4::uuid[] IS NULL OR COALESCE(a.effective_crm_campaign_id, l.campaign_id) = ANY($4::uuid[]))
    ), ev AS (
      SELECT c.*,
        EXISTS (SELECT 1 FROM lead_milestone_events e WHERE e.tenant_id = $1 AND e.milestone = 'qualified' AND NOT e.suppressed AND (e.lead_id = c.id OR e.lead_id IN (SELECT m.id FROM leads m WHERE m.tenant_id = $1 AND m.merged_into_id = c.id))) AS qualified,
        EXISTS (SELECT 1 FROM lead_milestone_events e WHERE e.tenant_id = $1 AND e.milestone = 'won' AND NOT e.suppressed AND (e.lead_id = c.id OR e.lead_id IN (SELECT m.id FROM leads m WHERE m.tenant_id = $1 AND m.merged_into_id = c.id))) AS acquired,
        c.stage_lc IN (SELECT lower(trim(s.name)) FROM lead_stages s WHERE s.tenant_id = $1 AND s.is_won) AS in_won_stage,
        c.stage_lc IN (SELECT lower(trim(s.name)) FROM lead_stages s WHERE s.tenant_id = $1 AND s.is_lost) AS in_lost_stage
      FROM cohort c
    )`;
  const p = [scope.workspaceId, scope.from, scope.to, campaignIds && campaignIds.length ? campaignIds : null];
  const [counts, booked, collected] = await Promise.all([
    query(`${base} SELECT campaign_id, count(*)::int AS leads, count(*) FILTER (WHERE qualified)::int AS qualified, count(*) FILTER (WHERE acquired)::int AS acquired,
             count(*) FILTER (WHERE acquired AND in_lost_stage)::int AS cancelled,
             count(*) FILTER (WHERE attribution_status = 'verified')::int AS verified,
             count(*) FILTER (WHERE attribution_status IN ('inferred', 'manual'))::int AS inferred,
             count(*) FILTER (WHERE campaign_id IS NULL)::int AS unattributed,
             count(*) FILTER (WHERE in_won_stage AND NOT acquired)::int AS won_without_event
           FROM ev GROUP BY campaign_id`, p),
    query(`${base} SELECT e.campaign_id, b.currency, COALESCE(sum(b.value), 0) AS amount, count(*)::int AS leads,
             count(*) FILTER (WHERE b.adjusted)::int AS adjusted, count(*) FILTER (WHERE b.booked_basis LIKE 'inferred%')::int AS inferred
           FROM ev e JOIN v_lead_booked b ON b.lead_id = e.id AND b.value IS NOT NULL WHERE e.acquired GROUP BY e.campaign_id, b.currency`, p),
    query(`${base} SELECT e.campaign_id, p.currency, p.paid_on_basis, e.acquired AS on_won_lead,
             COALESCE(sum(CASE p.kind WHEN 'payment' THEN p.amount WHEN 'refund' THEN -p.amount WHEN 'reversal' THEN -p.amount
                                 ELSE CASE p.adjustment_direction WHEN 'credit' THEN p.amount ELSE -p.amount END END) FILTER (WHERE p.status = 'completed'), 0) AS net,
             COALESCE(sum(p.amount) FILTER (WHERE p.status = 'pending' AND p.kind = 'payment'), 0) AS pending
           FROM ev e
           JOIN leads pl ON pl.tenant_id = $1 AND (pl.id = e.id OR pl.merged_into_id = e.id)
           JOIN lead_payments p ON p.lead_id = pl.id AND p.tenant_id = $1
           GROUP BY e.campaign_id, p.currency, p.paid_on_basis, e.acquired`, p),
  ]);
  return { counts: counts.rows, booked: booked.rows, collected: collected.rows };
};

// ---- assembly ----------------------------------------------------------------------------------------------------------------------------
const emptyGroup = (campaignId) => ({
  campaign_id: campaignId, leads: 0, qualified: 0, acquired: 0, cancelled: 0, verified: 0, inferred: 0, unattributed: 0, won_without_event: 0,
  booked: {}, booked_detail: [], collected: {}, collected_on_won: {}, collected_on_non_won: {}, by_basis: { confirmed: {}, estimated: {}, unknown: {} }, pending: {}, spendRows: [],
});
const add = (map, key, v) => { map[key] = round2(num(map[key]) + num(v)); };

const buildGroups = ({ counts, booked, collected }, spendRows) => {
  const groups = new Map(); const get = (k) => { const key = k || null; if (!groups.has(key)) groups.set(key, emptyGroup(key)); return groups.get(key); };
  for (const r of counts) {
    const g = get(r.campaign_id);
    for (const k of ['leads', 'qualified', 'acquired', 'cancelled', 'verified', 'inferred', 'unattributed', 'won_without_event']) g[k] += num(r[k]);
  }
  for (const r of booked) { const g = get(r.campaign_id); add(g.booked, r.currency, r.amount); g.booked_detail.push({ currency: r.currency, amount: round2(r.amount), leads: r.leads, adjusted: r.adjusted, inferred: r.inferred }); }
  for (const r of collected) {
    const g = get(r.campaign_id);
    add(g.collected, r.currency, r.net); add(r.on_won_lead ? g.collected_on_won : g.collected_on_non_won, r.currency, r.net);
    add(g.by_basis[r.paid_on_basis] || (g.by_basis[r.paid_on_basis] = {}), r.currency, r.net); add(g.pending, r.currency, r.pending);
  }
  for (const s of spendRows) { if (groups.has(s.campaign_id)) groups.get(s.campaign_id).spendRows.push(s); else if (s.campaign_id) get(s.campaign_id).spendRows.push(s); }
  return groups;
};

const spendOf = (rows) => {
  const byCurrency = {};
  for (const s of rows) if (s.currency) add(byCurrency, s.currency, s.spend);
  return { measured: rows.length > 0, byCurrency };
};

const present = (g, names) => {
  const spend = spendOf(g.spendRows);
  const { ratios, spend: spendValue, spend_currency, spend_reason } = computeRatios({ leads: g.leads, qualified: g.qualified, acquired: g.acquired, spend, booked: g.booked, collected: g.collected });
  const list = (m) => Object.entries(m).map(([currency, amount]) => ({ currency, amount: round2(amount) }));
  return {
    campaign_id: g.campaign_id, campaign_name: g.campaign_id ? (names.get(g.campaign_id) || null) : null, unattributed: !g.campaign_id,
    leads: g.leads, qualified: g.qualified, acquired: g.acquired, cancelled: g.cancelled,
    booked: list(g.booked), booked_detail: g.booked_detail,
    collected: { net: list(g.collected), on_won_leads: list(g.collected_on_won), on_non_won_leads: list(g.collected_on_non_won), by_date_basis: Object.fromEntries(Object.entries(g.by_basis).map(([k, v]) => [k, list(v)])), pending_not_counted: list(g.pending) },
    spend: g.campaign_id ? { measured: spend.measured, amount: spendValue, currency: spend_currency, by_currency: spend.byCurrency, reason: spend_reason } : { measured: false, amount: null, currency: null, by_currency: {}, reason: 'not_applicable_unattributed' },
    ratios: g.campaign_id ? ratios : Object.fromEntries(Object.keys(ratios).map((k) => [k, { value: null, reason: 'not_applicable_unattributed' }])),
  };
};

// Totals: counts and revenue for EVERYTHING in the cohort, ratios only over MEASURED campaigns (otherwise revenue from
// campaigns with no spend data would inflate ROAS).
const totals = (groups, names) => {
  const all = emptyGroup(null);
  const measured = emptyGroup(null);
  const fold = (into, g) => {
    for (const k of ['leads', 'qualified', 'acquired', 'cancelled', 'verified', 'inferred', 'unattributed', 'won_without_event']) into[k] += g[k];
    for (const m of ['booked', 'collected', 'collected_on_won', 'collected_on_non_won', 'pending']) for (const [c, v] of Object.entries(g[m])) add(into[m], c, v);
    for (const b of Object.keys(g.by_basis)) for (const [c, v] of Object.entries(g.by_basis[b])) add(into.by_basis[b] || (into.by_basis[b] = {}), c, v);
    into.booked_detail.push(...g.booked_detail); into.spendRows.push(...g.spendRows);
  };
  for (const g of groups.values()) { fold(all, g); if (g.campaign_id && g.spendRows.length) fold(measured, g); }
  const presentAll = present({ ...all, campaign_id: 'all' }, names);
  const { ratios, spend, spend_currency, spend_reason } = computeRatios({ leads: measured.leads, qualified: measured.qualified, acquired: measured.acquired, spend: spendOf(measured.spendRows), booked: measured.booked, collected: measured.collected });
  return { ...presentAll, campaign_id: undefined, campaign_name: undefined, unattributed: undefined, spend: { measured: measured.spendRows.length > 0, amount: spend, currency: spend_currency, by_currency: spendOf(measured.spendRows).byCurrency, reason: spend_reason }, ratios, ratios_scope: 'campaigns_with_spend_data', ratios_cover: { leads: measured.leads, acquired: measured.acquired }, _all: all };
};

async function getCohortMetrics(req, { campaignIds = null } = {}) {
  const missing = await missingObjects();
  if (missing.length) { const e = new Error('Cohort reporting is not set up in this database yet.'); e.status = 503; e.code = 'cohort_unavailable'; e.missing = missing; throw e; }
  const scope = await metricScope(req);
  const [rows, spendRows] = await Promise.all([cohortRows(scope, { campaignIds }), adSpend(scope, campaignIds)]);
  const groups = buildGroups(rows, spendRows);
  const ids = [...groups.keys()].filter(Boolean);
  const names = new Map(ids.length ? (await query('SELECT id, name FROM campaigns WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [scope.workspaceId, ids])).rows.map((r) => [r.id, r.name]) : []);
  const t = totals(groups, names); const all = t._all; delete t._all;
  const unattributed = groups.has(null) ? present(groups.get(null), names) : null;
  const campaigns = [...groups.values()].filter((g) => g.campaign_id).map((g) => present(g, names)).sort((a, b) => b.leads - a.leads);
  const ageDays = Math.max(0, Math.floor((Date.now() - scope.to.getTime()) / 864e5));
  const cohort = {
    model: 'cohort', as_of: new Date().toISOString(), from: scope.from.toISOString(), to: scope.to.toISOString(),
    definition: 'Leads created in the range, grouped by the campaign that originally brought them. Their later conversions and payments are counted in the cohort.',
    totals: t, campaigns, unattributed_row: unattributed,
    quality: {
      attribution: { verified: all.verified, inferred_or_manual: all.inferred, unattributed: all.unattributed, coverage_pct: all.leads ? round2(((all.leads - all.unattributed) / all.leads) * 100) : null },
      milestones: { won_stage_without_event: all.won_without_event },
      booked: { inferred_from_deal_value: all.booked_detail.reduce((a, d) => a + d.inferred, 0), adjusted: all.booked_detail.reduce((a, d) => a + d.adjusted, 0) },
      maturity: { days_since_cohort_end: scope.to.getTime() > Date.now() ? 0 : ageDays, note: 'Results keep changing as these leads convert and pay. Compare cohorts of the same age.' },
    },
  };
  return { cohort, scope };
}

// ---- shadow mode: compare with the legacy figures and record the differences -----------------------------------------------------
async function recordShadow(scope, cohort) {
  const legacy = await getMetrics(scope);
  const all = [
    ['leads', num(legacy.crm_leads), cohort.totals.leads],
    ['customers', num(legacy.converted), cohort.totals.acquired],
    ['qualified', num(legacy.qualified), cohort.totals.qualified],
  ];
  const sc = { from: scope.from.toISOString(), to: scope.to.toISOString() };
  const ins = [];
  for (const [metric, l, c] of all) {
    ins.push(query('INSERT INTO metric_shadow_log (tenant_id, metric, scope, legacy, cohort, delta) VALUES ($1,$2,$3,$4,$5,$6)', [scope.workspaceId, metric, JSON.stringify(sc), l, c, c - l]));
  }
  await Promise.all(ins).catch((e) => { if (e.code !== '42P01') throw e; }); // the log table may not be installed yet: shadow still serves
  return all.map(([metric, legacyValue, cohortValue]) => ({ metric, legacy: legacyValue, cohort: cohortValue, delta: cohortValue - legacyValue }));
}

// ---- health: can the cohort numbers be trusted yet? ------------------------------------------------------------------------------------
async function getHealth(tenantId) {
  const missing = await missingObjects();
  const checks = [];
  const add2 = (id, severity, ok, message, detail = {}) => checks.push({ id, severity, ok, message, ...detail });
  add2('migrations', 'error', missing.length === 0, missing.length ? `Not installed: ${missing.map((m) => m.object).join(', ')}` : 'All Phase 1 tables are installed.', { missing });
  if (missing.length) return { tenant_id: tenantId, ok: false, checks };
  const q = async (sql) => (await query(sql, [tenantId])).rows[0];
  const wonGap = await q(`SELECT count(*)::int AS n FROM leads l WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL
      AND lower(trim(l.stage)) IN (SELECT lower(trim(name)) FROM lead_stages WHERE tenant_id = $1 AND is_won)
      AND NOT EXISTS (SELECT 1 FROM lead_milestone_events e WHERE e.lead_id = l.id AND e.milestone = 'won' AND NOT e.suppressed)`);
  add2('won_without_event', 'warning', wonGap.n === 0, wonGap.n ? `${wonGap.n} lead(s) are in a won stage without a counted Won event; run the milestone backfill.` : 'Every Won lead has its Won event.', { count: wonGap.n });
  const noAttr = await q(`SELECT count(*)::int AS n FROM leads l WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM lead_attribution a WHERE a.lead_id = l.id)`);
  add2('attribution_missing', 'warning', noAttr.n === 0, noAttr.n ? `${noAttr.n} lead(s) have no attribution record; run the attribution backfill.` : 'Every lead has an attribution record.', { count: noAttr.n });
  const firstWon = await q(`SELECT count(*)::int AS n FROM lead_stages s WHERE s.tenant_id = $1 AND COALESCE(s.is_active, true) AND (s.is_won OR s.is_lost)
      AND COALESCE(s.pos, s.position) = (SELECT min(COALESCE(x.pos, x.position)) FROM lead_stages x WHERE x.tenant_id = $1 AND COALESCE(x.is_active, true))`);
  add2('entry_stage_flagged', 'error', firstWon.n === 0, firstWon.n ? 'The first stage (where new leads land) is flagged Won or Lost, which would corrupt conversion counts.' : 'The entry stage is not flagged Won or Lost.');
  const noWonStage = await q(`SELECT (NOT EXISTS (SELECT 1 FROM lead_stages WHERE tenant_id = $1 AND is_won AND COALESCE(is_active, true)))::int AS n`);
  add2('won_stage_exists', 'error', noWonStage.n === 0, noWonStage.n ? 'No active stage is flagged Won, so no customer can be counted.' : 'An active Won stage exists.');
  const advance = await q(`SELECT count(*)::int AS n FROM leads l WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL AND COALESCE(l.advance_received, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM lead_payments p WHERE p.lead_id = l.id)`);
  add2('advances_not_migrated', 'warning', advance.n === 0, advance.n ? `${advance.n} lead(s) have an advance recorded the old way and nothing in the payment ledger; run the advance migration (dry run first).` : 'Every legacy advance is in the ledger.', { count: advance.n });
  const noBooking = await q(`SELECT count(*)::int AS n FROM leads l WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL AND COALESCE(l.deal_value, 0) > 0 AND l.booked_at IS NULL
      AND EXISTS (SELECT 1 FROM lead_milestone_events e WHERE e.lead_id = l.id AND e.milestone = 'won' AND NOT e.suppressed)`);
  add2('booking_missing', 'warning', noBooking.n === 0, noBooking.n ? `${noBooking.n} Won lead(s) with a price have no booked-value snapshot.` : 'Every Won lead with a price has a booked value.', { count: noBooking.n });
  const cur = await q(`SELECT count(DISTINCT a.currency)::int AS n FROM ad_accounts a WHERE a.tenant_id = $1 AND a.currency IS NOT NULL`);
  add2('ad_account_currencies', 'info', cur.n <= 1, cur.n > 1 ? 'Ad accounts use more than one currency; ratios are only shown where spend and revenue share a currency.' : 'Ad accounts share one currency.');
  return { tenant_id: tenantId, ok: checks.filter((c) => c.severity === 'error').every((c) => c.ok), checks };
}

module.exports = { computeRatios, cohortRows, buildGroups, spendOf, present, missingObjects, getCohortMetrics, recordShadow, getHealth, REQUIRED_OBJECTS, round2 };
