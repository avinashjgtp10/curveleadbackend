// Cost per lead for Click-to-WhatsApp: spend and leads must cover the SAME dates, and a figure is only given when it
// can be trusted. Lifetime campaign spend divided by a 30-day lead count (the old calculation) overstated the cost.
const round2 = (n) => Math.round(n * 100) / 100;

// spendRows: [{ campaign_id, currency, spend }] for the window (from services/metrics adSpend). Returns one result per campaign.
const costPerLead = (spendRows, leads) => {
  const cur = {};
  for (const s of spendRows || []) if (s.currency) cur[s.currency] = round2((cur[s.currency] || 0) + (Number(s.spend) || 0));
  const currencies = Object.keys(cur);
  if (!spendRows || !spendRows.length) return { spend: null, currency: null, cost_per_lead: null, reason: 'not_measured' };
  if (currencies.length > 1) return { spend: null, currency: null, spend_by_currency: cur, cost_per_lead: null, reason: 'mixed_spend_currencies' };
  const spend = currencies.length ? cur[currencies[0]] : 0;
  if (!(spend > 0)) return { spend, currency: currencies[0] || null, cost_per_lead: null, reason: 'no_spend' };
  if (!(leads > 0)) return { spend, currency: currencies[0], cost_per_lead: null, reason: 'no_leads' };
  return { spend, currency: currencies[0], cost_per_lead: round2(spend / leads), reason: null };
};

module.exports = { costPerLead };
