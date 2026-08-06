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

module.exports = { findOrCreateMetaCampaign };
