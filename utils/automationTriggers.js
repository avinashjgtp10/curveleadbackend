const { query } = require('../config/db');
const { createNotification } = require('../controllers/notificationController');

// Enrolls a lead in a sequence, scheduling the first step per its delay_minutes.
// No-ops if the sequence has no steps, if the lead is already enrolled in it
// (a lead is enrolled in a given sequence at most once, ever), or if the lead
// has opted out of automation / been marked unresponsive.
const enrollLead = async ({ tenantId, leadId, sequenceId, ruleId = null }) => {
  const leadState = await query(
    'SELECT opted_out, automation_unresponsive FROM leads WHERE id = $1',
    [leadId]
  );
  if (leadState.rows[0]?.opted_out || leadState.rows[0]?.automation_unresponsive) return;

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

// Cancels every active enrollment for a lead, across all sequences. Shared by
// opt-out, stop-on-reply, and lost-stage cancellation — the reason is recorded
// for reporting/debugging.
const cancelActiveEnrollments = async ({ tenantId, leadId, reason }) => {
  await query(
    `UPDATE automation_enrollments SET status = 'cancelled', cancelled_at = NOW(), cancelled_reason = $3
     WHERE tenant_id = $1 AND lead_id = $2 AND status = 'active'`,
    [tenantId, leadId, reason]
  );
};

// High-value leads (hot score, or from a priority campaign) skip automation
// entirely and go straight to a human instead of being enrolled in a sequence.
const escalateInsteadOfAutomate = async ({ tenantId, lead }) => {
  const isHot = lead.lead_score === 'hot';
  let isPriorityCampaign = false;
  if (lead.campaign_id) {
    const c = await query('SELECT is_priority FROM campaigns WHERE id = $1', [lead.campaign_id]);
    isPriorityCampaign = !!c.rows[0]?.is_priority;
  }
  if (!isHot && !isPriorityCampaign) return false;

  const title = `High-value lead — ${lead.name}`;
  const body = 'Hot lead or priority campaign — automation skipped, please reach out personally.';
  if (lead.assigned_to) {
    await createNotification(tenantId, lead.assigned_to, title, body, 'lead_escalation', 'lead', lead.id);
  } else {
    const admins = await query(
      `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`,
      [tenantId]
    );
    for (const admin of admins.rows) {
      await createNotification(tenantId, admin.id, title, body, 'lead_escalation', 'lead', lead.id);
    }
  }
  return true;
};

// Called from every lead-creation path (manual add, Meta sync/webhook, embed ingest).
// Precedence: escalation (skip automation entirely) > campaign-specific rule
// (enroll only in it, skip the generic rule) > generic new_lead rule.
const checkNewLeadTriggers = async ({ tenantId, lead }) => {
  if (!lead?.id) return;

  const escalated = await escalateInsteadOfAutomate({ tenantId, lead });
  if (escalated) return;

  if (lead.campaign_id) {
    const campaignRules = await query(
      `SELECT id, sequence_id FROM automation_rules
       WHERE tenant_id = $1 AND trigger_type = 'campaign' AND campaign_id = $2 AND is_active = true`,
      [tenantId, lead.campaign_id]
    );
    if (campaignRules.rows.length) {
      for (const rule of campaignRules.rows) {
        await enrollLead({ tenantId, leadId: lead.id, sequenceId: rule.sequence_id, ruleId: rule.id });
      }
      return;
    }
  }

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
    await cancelActiveEnrollments({ tenantId, leadId, reason: 'stage_lost' });
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

module.exports = { checkNewLeadTriggers, checkStageChangeTriggers, enrollLead, cancelActiveEnrollments };
