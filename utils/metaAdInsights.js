const { query } = require('../config/db');
const { findOrCreateMetaCampaign } = require('./metaCampaignMatch');

const GRAPH = 'https://graph.facebook.com/v25.0';

// The Ads Manager statuses to pull — Insights only ever returns campaigns that
// have delivered something, but Ads Manager itself lists every campaign in
// these states regardless of spend (including ones still in draft/review).
const STATUSES = ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'PENDING_REVIEW',
  'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED',
  'IN_PROCESS', 'WITH_ISSUES'];

// Every campaign in the ad account as Ads Manager shows it (id, name, status),
// paginated — independent of whether the campaign has spent anything yet.
const fetchAllCampaigns = async (adAccountId, accessToken) => {
  const filtering = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: STATUSES }]);
  const campaigns = new Map();
  let url = `${GRAPH}/${adAccountId}/campaigns`
    + `?fields=id,name,effective_status&filtering=${encodeURIComponent(filtering)}`
    + `&limit=200&access_token=${encodeURIComponent(accessToken)}`;

  while (url) {
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) {
      console.error('fetchAllCampaigns Graph API error:', JSON.stringify(data.error));
      throw new Error(data.error.message);
    }
    for (const c of data.data || []) {
      campaigns.set(c.id, { name: c.name, status: c.effective_status });
    }
    url = data.paging?.next || null;
  }

  return campaigns;
};

// Pulls every campaign in the tenant's connected ad account — matching what
// they see in Ads Manager, not just ones that have generated leads or spend —
// then layers spend/impressions/clicks on top for whichever have delivered.
// Upserts into `campaigns` via the same find-or-create helper attribution uses.
// date_preset=maximum (all-time since the campaign began) to match how
// actual_spend has always been used — a running total, not a period figure.
const syncTenantAdInsights = async (tenantId) => {
  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const { meta_ad_account_id, meta_ads_access_token } = result.rows[0]?.settings || {};
  if (!meta_ad_account_id || !meta_ads_access_token) {
    return { synced: 0, reason: 'not_configured' };
  }

  // Best-effort: a failure here (bad token, permission, transient Meta error)
  // must not block the spend/impressions/clicks sync below, which worked
  // before full-campaign-list syncing existed.
  let allCampaigns = null;
  try {
    allCampaigns = await fetchAllCampaigns(meta_ad_account_id, meta_ads_access_token);
  } catch (e) {
    console.error('fetchAllCampaigns failed, falling back to insights-only sync:', e.message);
  }

  let synced = 0;
  if (allCampaigns) {
    for (const [campaignId, info] of allCampaigns) {
      const dbId = await findOrCreateMetaCampaign({ tenantId, campaignId, campaignName: info.name });
      if (!dbId) continue;
      await query(
        `UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2`,
        [info.status === 'ACTIVE' ? 'active' : 'paused', dbId]
      );
      synced++;
    }
  }

  const url = `${GRAPH}/${meta_ad_account_id}/insights`
    + `?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks`
    + `&date_preset=maximum&limit=200&access_token=${encodeURIComponent(meta_ads_access_token)}`;

  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  for (const row of data.data || []) {
    const campaignId = await findOrCreateMetaCampaign({
      tenantId, campaignId: row.campaign_id, campaignName: row.campaign_name,
    });
    if (!campaignId) continue;

    await query(
      `UPDATE campaigns SET actual_spend = $1, impressions = $2, clicks = $3, updated_at = NOW() WHERE id = $4`,
      [parseFloat(row.spend) || 0, parseInt(row.impressions) || 0, parseInt(row.clicks) || 0, campaignId]
    );
    // Fallback path (fetchAllCampaigns failed) — insights rows are the only
    // source of synced campaigns, so count them here instead.
    if (!allCampaigns) synced++;
  }

  const adsSynced = await syncTenantAdLevelInsights(tenantId, meta_ad_account_id, meta_ads_access_token);

  return { synced, ads_synced: adsSynced };
};

// Same idea as the campaign-level sync above, but at the individual ad level —
// which ad creative is actually driving results, not just the campaign as a whole.
const syncTenantAdLevelInsights = async (tenantId, adAccountId, accessToken) => {
  const url = `${GRAPH}/${adAccountId}/insights`
    + `?level=ad&fields=ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks`
    + `&date_preset=maximum&limit=200&access_token=${encodeURIComponent(accessToken)}`;

  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  let synced = 0;
  for (const row of data.data || []) {
    if (!row.ad_id) continue;
    const campaignId = await findOrCreateMetaCampaign({
      tenantId, campaignId: row.campaign_id, campaignName: row.campaign_name, adsetId: row.adset_id,
    });

    await query(
      `INSERT INTO meta_ads (tenant_id, campaign_id, meta_ad_id, meta_adset_id, name, spend, impressions, clicks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, meta_ad_id) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, meta_adset_id = EXCLUDED.meta_adset_id, name = EXCLUDED.name,
         spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, updated_at = NOW()`,
      [tenantId, campaignId || null, row.ad_id, row.adset_id || null, row.ad_name || null,
       parseFloat(row.spend) || 0, parseInt(row.impressions) || 0, parseInt(row.clicks) || 0]
    );
    synced++;
  }

  return synced;
};

module.exports = { syncTenantAdInsights };
