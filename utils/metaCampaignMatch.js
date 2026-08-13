const axios = require('axios');
const { query } = require('../config/db');

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

  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const { meta_ads_access_token } = result.rows[0]?.settings || {};
  if (!meta_ads_access_token) return null;

  try {
    const { data } = await axios.get(`https://graph.facebook.com/v25.0/${adId}`, {
      params: { fields: 'name,campaign{id,name},adset{id,name}', access_token: meta_ads_access_token },
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
