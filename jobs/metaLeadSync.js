const { query } = require('../config/db');
const { syncFacebookLeadsForTenant } = require('../utils/metaLeadSync');

// Safety net for the real-time Meta webhook: pulls new lead-ad leads for every
// tenant with a connected Facebook page, so leads are captured, assigned to the
// right team member and enrolled in automations without anyone opening the app.
const runMetaLeadSync = async () => {
  try {
    const tenants = await query(
      `SELECT id FROM tenants WHERE settings->>'meta_page_id' IS NOT NULL AND settings->>'meta_page_id' != ''
         AND settings->>'meta_page_access_token' IS NOT NULL AND settings->>'meta_page_access_token' != ''`
    );

    let created = 0, failed = 0;
    for (const t of tenants.rows) {
      try {
        const result = await syncFacebookLeadsForTenant(t.id);
        created += result.created;
      } catch (e) {
        failed++;
        console.error(`[MetaLeadSync] Tenant ${t.id} failed:`, e.message);
      }
    }

    if (created > 0 || failed > 0) {
      console.log(`[MetaLeadSync] ${tenants.rows.length} tenant(s), ${created} new lead(s) imported, ${failed} failed`);
    }
  } catch (e) {
    console.error('[MetaLeadSync] Error:', e.message);
  }
};

module.exports = { runMetaLeadSync };
