const { query } = require('../config/db');

// Idempotent — only ever sets first_response_at once per lead (guarded in the WHERE clause,
// safe under concurrent calls without a separate read-then-write).
// Returns the updated lead row, or null if this lead already had a first response (or doesn't exist).
async function recordFirstResponse(tenantId, leadId, { by = null, type }) {
  const result = await query(
    `UPDATE leads
     SET first_response_at = NOW(),
         first_response_by = $3,
         first_response_type = $4,
         response_time_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - created_at))::INTEGER)
     WHERE id = $1 AND tenant_id = $2 AND first_response_at IS NULL
     RETURNING *`,
    [leadId, tenantId, by, type]
  );
  return result.rows[0] || null;
}

module.exports = { recordFirstResponse };
