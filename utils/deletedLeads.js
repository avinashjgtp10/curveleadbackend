const { query } = require('../config/db');

// Records that a Meta lead was intentionally deleted, so sync/webhooks don't
// silently re-import it later — see migration_deleted_meta_leads.sql.
const tombstoneMetaLead = async (tenantId, metaLeadId) => {
  if (!metaLeadId) return;
  await query(
    `INSERT INTO deleted_meta_leads (tenant_id, meta_lead_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, meta_lead_id) DO NOTHING`,
    [tenantId, metaLeadId]
  );
};

const isMetaLeadDeleted = async (tenantId, metaLeadId) => {
  if (!metaLeadId) return false;
  const result = await query(
    'SELECT 1 FROM deleted_meta_leads WHERE tenant_id = $1 AND meta_lead_id = $2',
    [tenantId, metaLeadId]
  );
  return result.rows.length > 0;
};

module.exports = { tombstoneMetaLead, isMetaLeadDeleted };
