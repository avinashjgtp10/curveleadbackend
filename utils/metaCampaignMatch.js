const axios = require('axios');
const { query } = require('../config/db');
const { GRAPH_URL } = require('../config/meta');

// Finds the CRM campaign matching a Meta campaign ID, auto-creating one
// (with the real Meta campaign name) if it doesn't exist yet — no manual
// campaign setup required before leads start flowing in.
const findOrCreateMetaCampaign = async ({ tenantId, campaignId, campaignName, adsetId }) => {
  if (!campaignId) return null;

  const existing = await query(
    'SELECT id FROM campaigns WHERE tenant_id = $1 AND meta_campaign_id = $2',
    [tenantId, campaignId]
  );
  if (existing.rows.length) {
    if (adsetId) {
      await query('UPDATE campaigns SET meta_adset_id = $1 WHERE id = $2', [adsetId, existing.rows[0].id]).catch(() => {});
    }
    return existing.rows[0].id;
  }

  const created = await query(
    `INSERT INTO campaigns (tenant_id, name, source, status, meta_campaign_id, meta_adset_id)
     VALUES ($1, $2, 'meta_ads', 'active', $3, $4)
     ON CONFLICT (tenant_id, meta_campaign_id) WHERE meta_campaign_id IS NOT NULL
     DO UPDATE SET meta_adset_id = COALESCE(EXCLUDED.meta_adset_id, campaigns.meta_adset_id)
     RETURNING id`,
    [tenantId, campaignName || `Meta Campaign ${campaignId}`, campaignId, adsetId || null]
  );
  return created.rows[0].id;
};

// Resolves a Meta ad ID (e.g. from a Click-to-WhatsApp message's `referral.source_id`)
// to a CRM campaign, via the tenant's connected ad account token. Returns null if the
// tenant hasn't connected an ad account (Integrations page) or the lookup fails —
// callers should treat that as "couldn't attribute automatically", not an error.
const resolveCampaignFromAdId = async ({ tenantId, adId }) => {
  if (!adId) return null;

  // Already synced by Ads Manager: no Graph call needed.
  const local = await query(
    `SELECT ac.external_id AS campaign_external_id, ac.name AS campaign_name, s.external_id AS adset_id, s.name AS adset_name, ad.name AS ad_name
     FROM ad_ads ad JOIN ad_adsets s ON s.id = ad.ad_adset_id JOIN ad_campaigns ac ON ac.id = s.ad_campaign_id
     WHERE ad.tenant_id = $1 AND ad.external_id = $2`, [tenantId, String(adId)]
  ).catch(() => ({ rows: [] }));
  if (local.rows[0]) {
    const r = local.rows[0];
    const campaignId = await findOrCreateMetaCampaign({ tenantId, campaignId: r.campaign_external_id, campaignName: r.campaign_name, adsetId: r.adset_id });
    return { campaignId, adName: r.ad_name || null, adsetName: r.adset_name || null };
  }

  // Not synced yet: ask Meta with the Ads Manager token, else the legacy Integrations token.
  let token = null;
  const account = await query(
    `SELECT a.id FROM ad_accounts a JOIN ad_oauth_tokens t ON t.id = a.token_id AND t.status = 'active'
     WHERE a.tenant_id = $1 AND a.provider = 'meta' AND a.is_active ORDER BY a.is_primary DESC LIMIT 1`, [tenantId]
  ).catch(() => ({ rows: [] }));
  if (account.rows[0]) token = (await require('../services/metaAds/client').getAccountWithToken(tenantId, account.rows[0].id).catch(() => null))?.token || null;
  if (token) return lookupAd({ tenantId, adId, token });

  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const { meta_ads_access_token } = result.rows[0]?.settings || {};
  if (!meta_ads_access_token) return null;
  return lookupAd({ tenantId, adId, token: meta_ads_access_token });
};

const lookupAd = async ({ tenantId, adId, token }) => {
  try {
    const { data } = await axios.get(`${GRAPH_URL}/${adId}`, {
      params: { fields: 'name,campaign{id,name},adset{id,name}' },
      headers: { Authorization: `Bearer ${token}` },
    });
    const campaignId = await findOrCreateMetaCampaign({
      tenantId, campaignId: data.campaign?.id, campaignName: data.campaign?.name, adsetId: data.adset?.id,
    });
    return { campaignId, adName: data.name || null, adsetName: data.adset?.name || null };
  } catch (e) {
    console.error('resolveCampaignFromAdId failed:', e.response?.data?.error?.message || e.message);
    return null;
  }
};

module.exports = { findOrCreateMetaCampaign, resolveCampaignFromAdId };
