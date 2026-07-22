const { query } = require('../config/db');

// Atomically reserves the next Lead ID (e.g. "LD-00042") for a tenant.
// Pass the transaction client when the lead insert must stay atomic with this reservation.
const nextLeadNumber = async (tenantId, client) => {
  const exec = client || { query };
  const result = await exec.query(
    `INSERT INTO lead_counter (tenant_id, last_number)
     VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_number = lead_counter.last_number + 1
     RETURNING last_number, prefix`,
    [tenantId]
  );
  const { last_number, prefix } = result.rows[0];
  return `${prefix}-${String(last_number).padStart(5, '0')}`;
};

// Reserves a contiguous block of `count` Lead IDs (for bulk imports) and returns
// a function that hands them out one at a time, in order.
const reserveLeadNumbers = async (tenantId, count) => {
  const result = await query(
    `INSERT INTO lead_counter (tenant_id, last_number)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET last_number = lead_counter.last_number + $2
     RETURNING last_number, prefix`,
    [tenantId, count]
  );
  const { last_number: reservedEnd, prefix } = result.rows[0];
  let next = reservedEnd - count + 1;
  return () => `${prefix}-${String(next++).padStart(5, '0')}`;
};

module.exports = { nextLeadNumber, reserveLeadNumbers };
