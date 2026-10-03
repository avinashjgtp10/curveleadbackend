const { query } = require('../config/db');

// Guards on stage flags (Batch 1 A). "Won" drives every converted / revenue / cost-per-customer
// number, so: a stage can't be both won and lost, and the first pipeline stage (where new
// leads land) can't be won — that would count every new lead as a customer.
const stageFlagError = ({ isWon, isLost, isFirst }) => {
  if (isWon && isLost) return 'A stage can be won or lost, not both.';
  if (isWon && isFirst) return "The first stage is where new leads start, so it can't be a won stage. Mark the stage where a lead becomes a customer instead.";
  return null;
};

// For an existing stage: its final flags after the update, and whether it's the first stage.
const checkStageUpdate = async ({ tenantId, stageId, isWon, isLost }) => {
  const r = (await query(
    `SELECT s.is_won, s.is_lost,
            COALESCE(s.pos, s.position) <= (SELECT min(COALESCE(x.pos, x.position)) FROM lead_stages x WHERE x.tenant_id = s.tenant_id AND COALESCE(x.is_active, true)) AS is_first
     FROM lead_stages s WHERE s.id = $1 AND s.tenant_id = $2`, [stageId, tenantId])).rows[0];
  if (!r) return null;
  return stageFlagError({ isWon: isWon ?? r.is_won, isLost: isLost ?? r.is_lost, isFirst: r.is_first });
};

module.exports = { stageFlagError, checkStageUpdate };
