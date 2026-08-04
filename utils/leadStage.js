const { query } = require('../config/db');
const { sendLeadConversionEvent } = require('./metaCapi');
const { checkStageChangeTriggers } = require('./automationTriggers');

// Reusable core of a stage change: updates the lead, logs history + activity,
// and fires a Meta CAPI event if the target stage is mapped. Used by system-driven
// stage changes (currently only the AI qualification path) — the human-initiated
// updateLead endpoint has its own richer validation and stays untouched.
const changeLeadStage = async ({ tenantId, leadId, newStageName, lostReason = null }) => {
  const current = await query('SELECT stage FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, tenantId]);
  if (!current.rows.length) return;
  const prevStage = current.rows[0].stage;
  if ((prevStage || '').toLowerCase() === newStageName.toLowerCase()) return;

  const stageInfo = await query(
    'SELECT is_won, is_lost, meta_event_name FROM lead_stages WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
    [tenantId, newStageName]
  );
  const info = stageInfo.rows[0] || {};

  const sets = ['stage = $1', 'updated_at = NOW()'];
  const params = [newStageName];
  let i = 2;
  if (info.is_won) sets.push('won_at = NOW()');
  if (info.is_lost) {
    sets.push('lost_at = NOW()');
    if (lostReason) { sets.push(`lost_reason = $${i++}`); params.push(lostReason); }
  }
  params.push(leadId, tenantId);

  const result = await query(
    `UPDATE leads SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
    params
  );
  if (!result.rows.length) return;
  const lead = result.rows[0];

  await query(
    `INSERT INTO lead_stage_history (tenant_id, lead_id, prev_stage, new_stage, changed_by)
     VALUES ($1, $2, $3, $4, NULL)`,
    [tenantId, leadId, prevStage, newStageName]
  ).catch(() => {});

  await query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
     VALUES ($1, $2, 'stage_change', $3, NULL)`,
    [tenantId, leadId, `Stage changed to ${newStageName}`]
  ).catch(() => {});

  if (lead.meta_lead_id && info.meta_event_name) {
    sendLeadConversionEvent({ tenantId, lead, eventName: info.meta_event_name }).catch(() => {});
  }

  checkStageChangeTriggers({
    tenantId, leadId, newStage: newStageName, isLost: !!info.is_lost,
  }).catch(() => {});
};

module.exports = { changeLeadStage };
