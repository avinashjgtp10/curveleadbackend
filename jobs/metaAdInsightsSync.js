const { query } = require('../config/db');
const { syncTenantAdInsights } = require('../utils/metaAdInsights');

const runMetaAdInsightsSync = async () => {
  try {
    const tenants = await query(
      `SELECT id FROM tenants WHERE settings->>'meta_ad_account_id' IS NOT NULL AND settings->>'meta_ad_account_id' != ''`
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
