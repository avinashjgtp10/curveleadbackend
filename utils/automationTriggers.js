const { query } = require('../config/db');

// Enrolls a lead in a sequence, scheduling the first step per its delay_minutes.
// No-ops if the sequence has no steps, or if the lead is already enrolled in it
// (a lead is enrolled in a given sequence at most once, ever).
const enrollLead = async ({ tenantId, leadId, sequenceId, ruleId = null }) => {
  const firstStep = await query(
    'SELECT delay_minutes FROM automation_sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC LIMIT 1',
    [sequenceId]
  );
  if (!firstStep.rows.length) return;

  await query(
    `INSERT INTO automation_enrollments (tenant_id, lead_id, sequence_id, rule_id, current_step, status, next_send_at)
     VALUES ($1, $2, $3, $4, 0, 'active', NOW() + ($5 || ' minutes')::INTERVAL)
     ON CONFLICT (tenant_id, lead_id, sequence_id) DO NOTHING`,
    [tenantId, leadId, sequenceId, ruleId, firstStep.rows[0].delay_minutes]
  );
};

// Called from every lead-creation path (manual add, Meta sync/webhook, embed ingest).
const checkNewLeadTriggers = async ({ tenantId, lead }) => {
  if (!lead?.id) return;

  const rules = await query(
    `SELECT id, sequence_id FROM automation_rules
     WHERE tenant_id = $1 AND trigger_type = 'new_lead' AND is_active = true`,
    [tenantId]
  );
  for (const rule of rules.rows) {
    await enrollLead({ tenantId, leadId: lead.id, sequenceId: rule.sequence_id, ruleId: rule.id });
  }
};

// Called from every stage-change path (human-driven updateLead, AI-driven changeLeadStage).
// A lead moving into a lost stage has any active enrollments cancelled rather than
// enrolled further — no point nurturing a dead lead.
const checkStageChangeTriggers = async ({ tenantId, leadId, newStage, isLost = false }) => {
  if (!leadId || !newStage) return;

  if (isLost) {
    await query(
      `UPDATE automation_enrollments SET status = 'cancelled', cancelled_at = NOW()
       WHERE tenant_id = $1 AND lead_id = $2 AND status = 'active'`,
      [tenantId, leadId]
    );
    return;
  }

  const rules = await query(
    `SELECT id, sequence_id FROM automation_rules
     WHERE tenant_id = $1 AND trigger_type = 'stage_change' AND is_active = true
       AND LOWER(stage_name) = LOWER($2)`,
    [tenantId, newStage]
  );
  for (const rule of rules.rows) {
    await enrollLead({ tenantId, leadId, sequenceId: rule.sequence_id, ruleId: rule.id });
  }
};

module.exports = { checkNewLeadTriggers, checkStageChangeTriggers, enrollLead };
