// Meta returns budgets in the account currency's minor units (paise for INR).
function parseBudgets(data) {
 const amount = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value) / 100;
 return { daily_budget: amount(data.daily_budget), lifetime_budget: amount(data.lifetime_budget) };
}
async function fetchAdSetBudgets(url, fetchPage) {
 const total = { daily_budget: null, lifetime_budget: null };
 while (url) {
  const response = await fetchPage(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  for (const row of data.data || []) {
   const amounts = parseBudgets(row);
   for (const key of Object.keys(total)) if (amounts[key] !== null) total[key] = (total[key] || 0) + amounts[key];
  }
  url = data.paging?.next || null;
 }
 return total;
}
module.exports = { parseBudgets, fetchAdSetBudgets };
