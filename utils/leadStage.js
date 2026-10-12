const { query, transaction } = require('../config/db');
const { checkStageChangeTriggers } = require('./automationTriggers');

// Reusable core of a stage change, used by system-driven stage changes (AI qualification,
// quotation acceptance); the human-initiated updateLead and bulkUpdate endpoints apply the same
// milestone rules in their own SQL.
//
// CRITICAL writes happen together, in ONE transaction, and their errors propagate (nothing is swallowed):
//   - the lead's stage,
//   - won_at   (the FIRST time the lead reaches a won stage: COALESCE, so a later won-to-won or
//               lost-to-won move never moves it and a repeat can never count a customer twice),
//   - lost_at / lost_reason when entering a lost stage,
//   - exactly one lead_stage_history row (written by the database trigger; if no trigger recorded it
//     this function records it itself, inside the same transaction, so there is never zero or two).
// NONCRITICAL work (activity log, automations, review request) runs AFTER commit and may fail alone.

const sameStage = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Runs on a transaction CLIENT; the caller owns BEGIN/COMMIT. Returns what happened.
const applyStageChange = async (client, { tenantId, leadId, newStageName, lostReason = null }) => {
  const locked = await client.query(
    'SELECT stage, won_at FROM leads WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [leadId, tenantId]);
  if (!locked.rows.length) return { changed: false, reason: 'not_found' };
  const previousStage = locked.rows[0].stage;
  if (sameStage(previousStage, newStageName)) return { changed: false, reason: 'same_stage', previousStage };

  const info = (await client.query(
    'SELECT name, is_won, is_lost, meta_event_name FROM lead_stages WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
    [tenantId, newStageName])).rows[0] || {};
  const stage = info.name || newStageName;

  const sets = ['stage = $1', 'updated_at = NOW()'];
  const params = [stage];
  let i = 2;
  if (info.is_won) sets.push('won_at = COALESCE(won_at, NOW())');
  if (info.is_lost) {
    sets.push('lost_at = NOW()');
    if (lostReason) { sets.push(`lost_reason = $${i++}`); params.push(lostReason); }
  }
  params.push(leadId, tenantId);

  const historyCount = async () => Number((await client.query(
    'SELECT count(*)::int AS n FROM lead_stage_history WHERE tenant_id = $1 AND lead_id = $2', [tenantId, leadId])).rows[0].n);
  const before = await historyCount();
  const updated = await client.query(
    `UPDATE leads SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`, params);
  if (!updated.rows.length) return { changed: false, reason: 'not_found' };
  if (await historyCount() === before) {
    // No trigger recorded the transition (not installed in this database): record it here, once.
    await client.query(
      `INSERT INTO lead_stage_history (tenant_id, lead_id, prev_stage, new_stage, changed_by) VALUES ($1, $2, $3, $4, NULL)`,
      [tenantId, leadId, previousStage, stage]);
  }
  return {
    changed: true, previousStage, stage, lead: updated.rows[0],
    isWon: !!info.is_won, isLost: !!info.is_lost,
    firstWon: !!info.is_won && !locked.rows[0].won_at,
  };
};

// Noncritical follow-ups of a committed stage change. Failures here never undo the change.
const afterStageChange = async ({ tenantId, leadId, result }) => {
  if (!result || !result.changed) return;
  await query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by) VALUES ($1, $2, 'stage_change', $3, NULL)`,
    [tenantId, leadId, `Stage changed to ${result.stage}`]
  ).catch(() => {});
  checkStageChangeTriggers({
    tenantId, leadId, newStage: result.stage, isLost: result.isLost, isWon: result.isWon,
  }).catch(() => {});
};

// Public entry point. Without `client` it runs its own transaction and the follow-ups right after it commits.
// With a `client` (the caller's open transaction) it joins it and returns `afterCommit`, which the caller
// must call once ITS transaction has committed.
const changeLeadStage = async ({ tenantId, leadId, newStageName, lostReason = null, client = null }) => {
  const args = { tenantId, leadId, newStageName, lostReason };
  if (client) {
    const result = await applyStageChange(client, args);
    result.afterCommit = () => afterStageChange({ tenantId, leadId, result });
    return result;
  }
  const result = await transaction((c) => applyStageChange(c, args));
  await afterStageChange({ tenantId, leadId, result });
  return result;
};

// The workspace's won stage (first active stage flagged is_won, by pipeline position) —
// workspaces name it "Won", "Converted", "Enrolled"… Falls back to "Won".
const wonStageName = async (tenantId) => (await query(
  `SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_won AND COALESCE(is_active, true)
   ORDER BY COALESCE(pos, position) NULLS LAST, name LIMIT 1`, [tenantId]
)).rows[0]?.name || 'Won';

module.exports = { wonStageName, changeLeadStage, applyStageChange, afterStageChange, sameStage };
