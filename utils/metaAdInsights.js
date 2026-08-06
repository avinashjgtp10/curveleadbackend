const { query } = require('../config/db');
const { findOrCreateMetaCampaign } = require('./metaCampaignMatch');

const GRAPH = 'https://graph.facebook.com/v25.0';

// Pulls campaign-level spend/impressions/clicks from Meta's Ads Insights API
// for one tenant's connected ad account, upserting into `campaigns` via the
// same find-or-create helper attribution uses. date_preset=maximum (all-time
// since the campaign began) to match how actual_spend has always been used —
// a running total, not a period figure.
const syncTenantAdInsights = async (tenantId) => {
  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const { meta_ad_account_id, meta_ads_access_token } = result.rows[0]?.settings || {};
  if (!meta_ad_account_id || !meta_ads_access_token) {
    return { synced: 0, reason: 'not_configured' };
  }

  const url = `${GRAPH}/${meta_ad_account_id}/insights`
    + `?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks`
    + `&date_preset=maximum&limit=200&access_token=${encodeURIComponent(meta_ads_access_token)}`;

  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  let synced = 0;
  for (const row of data.data || []) {
    const campaignId = await findOrCreateMetaCampaign({
      tenantId, campaignId: row.campaign_id, campaignName: row.campaign_name,
    });
    if (!campaignId) continue;

    await query(
      `UPDATE campaigns SET actual_spend = $1, impressions = $2, clicks = $3, updated_at = NOW() WHERE id = $4`,
      [parseFloat(row.spend) || 0, parseInt(row.impressions) || 0, parseInt(row.clicks) || 0, campaignId]
    );
    synced++;
  }

  return { synced };
};

module.exports = { syncTenantAdInsights };
