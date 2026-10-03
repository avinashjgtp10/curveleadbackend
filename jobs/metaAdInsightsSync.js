const { query } = require('../config/db');
const { syncTenantAdInsights } = require('../utils/metaAdInsights');

const runMetaAdInsightsSync = async () => {
  try {
    const tenants = await query(
      `SELECT id FROM tenants t WHERE settings->>'meta_ad_account_id' IS NOT NULL AND settings->>'meta_ad_account_id' != ''
         -- Workspaces connected in Ads Manager are synced by jobs/adsJobs.js instead.
         AND NOT EXISTS (SELECT 1 FROM ad_accounts a WHERE a.tenant_id = t.id AND a.provider = 'meta' AND a.is_active)`
    );

    let synced = 0, failed = 0;
    for (const t of tenants.rows) {
      try {
        const result = await syncTenantAdInsights(t.id);
        synced += result.synced || 0;
      } catch (e) {
        failed++;
        console.error(`[MetaAdInsightsSync] Tenant ${t.id} failed:`, e.message);
      }
    }

    if (tenants.rows.length > 0) {
      console.log(`[MetaAdInsightsSync] ${tenants.rows.length} tenant(s), ${synced} campaign(s) synced, ${failed} failed`);
    }
  } catch (e) {
    console.error('[MetaAdInsightsSync] Error:', e.message);
  }
};

module.exports = { runMetaAdInsightsSync };
