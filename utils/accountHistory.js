const { query } = require('../config/db');

// Reads who an account is BEFORE it is deleted, so the history row can describe it afterwards.
const snapshotUser = async (userId) => {
  try {
    const result = await query(
      `SELECT u.name, u.email, u.role, u.tenant_id, t.name AS tenant_name
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [userId]
    );
    return result.rows[0] || null;
  } catch (e) { console.error('Account snapshot failed:', e.message); return null; }
};

// Appends one row to account_deletion_history. Best effort: if the table has not been migrated, or the
// insert fails, the deletion that already happened must not be reported as failed.
const recordDeletion = async ({ accountType, name, email, role, tenantId, tenantName, deletedBy, reason }) => {
  try {
    await query(
      `INSERT INTO account_deletion_history
         (account_type, name, email, role, tenant_id, tenant_name, deleted_by, deleted_by_name, deleted_by_email, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [accountType, name || null, email || null, role || null, tenantId || null, tenantName || null,
        deletedBy?.id || null, deletedBy?.name || null, deletedBy?.email || null, reason || null]
    );
  } catch (e) {
    if (e.code !== '42P01') console.error('Record account deletion failed:', e.message);
  }
};

module.exports = { snapshotUser, recordDeletion };
