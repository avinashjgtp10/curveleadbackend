const { query } = require('../../config/db');
const { getAccountWithToken, markToken } = require('./client');
const { fetchHierarchy, saveHierarchy } = require('./hierarchy');
const { fetchDailyAdInsights, saveDailyInsights, syncLifetimeCampaignTotals } = require('./insights');
const { MetaGraphError } = require('../../utils/metaGraph');

const BACKFILL_DAYS = 90;
// Meta keeps updating recent days (attribution windows), so each run re-pulls these.
const REFRESH_DAYS = 3;

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

const syncRange = (account, now = new Date()) => {
  const until = isoDate(now);
  const backfillFrom = isoDate(addDays(now, -BACKFILL_DAYS));
  if (!account.insights_synced_through) return { since: backfillFrom, until };
  const through = new Date(`${String(account.insights_synced_through).slice(0, 10)}T00:00:00Z`);
  const since = isoDate(new Date(Math.min(addDays(through, -REFRESH_DAYS + 1).getTime(), addDays(now, -REFRESH_DAYS + 1).getTime())));
  return { since: since < backfillFrom ? backfillFrom : since, until };
};

// Full sync for one ad account: hierarchy, then daily insights for the range.
const syncAdAccount = async ({ tenantId, adAccountId }) => {
  const found = await getAccountWithToken(tenantId, adAccountId);
  if (!found) return { skipped: 'not_found' };
  const { account, token } = found;
  if (!account.is_active) return { skipped: 'inactive' };
  if (!token || account.token_status !== 'active') {
    await query('UPDATE ad_accounts SET sync_error = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId, adAccountId, 'Reconnect Facebook: the access token is missing or expired.']);
    return { skipped: 'no_token' };
  }

  try {
    const campaigns = await fetchHierarchy(account.external_id, token);
    await saveHierarchy({ tenantId, adAccountId, campaigns });
    const range = syncRange(account);
    const rows = await fetchDailyAdInsights(account.external_id, token, range);
    const saved = await saveDailyInsights({ tenantId, adAccountId, externalAccountId: account.external_id, ...range, rows });
    await syncLifetimeCampaignTotals({ tenantId, externalAccountId: account.external_id, token });
    await query(
      `UPDATE ad_accounts SET last_synced_at = now(), insights_synced_through = $3, sync_error = NULL, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, adAccountId, range.until]
    );
    return { campaigns: campaigns.length, insight_rows: saved, ...range };
  } catch (e) {
    if (e instanceof MetaGraphError && e.isAuth && account.token_row_id) await markToken(tenantId, account.token_row_id, 'expired', e.message);
    await query('UPDATE ad_accounts SET sync_error = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId, adAccountId, String(e.message).slice(0, 500)]);
    throw e;
  }
};

module.exports = { syncAdAccount, syncRange, BACKFILL_DAYS, REFRESH_DAYS };
