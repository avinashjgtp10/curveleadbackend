const { query } = require('../config/db');
const { createNotification } = require('../controllers/notificationController');
const { sendReviewRequest } = require('./googleReviewRequest');

const TRIGGER_LABELS = {
  new_lead: 'New Lead Created',
  stage_change: (r) => `Lead Stage Changed to "${r.stage_name}"`,
  campaign: 'Lead From Campaign',
  lead_source: (r) => `Lead Source: ${r.source_value}`,
  lead_status: (r) => `Lead Status: ${r.status_value}`,
};
const ruleTriggerLabel = (rule) => {
  const l = TRIGGER_LABELS[rule.trigger_type];
  return typeof l === 'function' ? l(rule) : (l || rule.trigger_type);
};

// Enrolls a lead in a sequence, scheduling the first step per its delay_minutes,
// and records the enrollment on the lead's Activity timeline (Automation Triggered
// + Sequence Started) so it's visible in Lead Details without joining automation
// tables. No-ops if the sequence has no steps, if the lead is already enrolled in
// it (a lead is enrolled in a given sequence at most once, ever), or if the lead
// has opted out of automation / been marked unresponsive.
const enrollLead = async ({ tenantId, leadId, sequenceId, ruleId = null }) => {
  const leadState = await query(
    'SELECT opted_out, automation_unresponsive FROM leads WHERE id = $1 AND tenant_id=$2',
    [leadId,tenantId]
  );
  if (!leadState.rows.length) return false;
  const owned=await query('SELECT id FROM automation_sequences WHERE id=$1 AND tenant_id=$2 AND is_active=true',[sequenceId,tenantId]);
  if (!owned.rows.length) return false;
  if (leadState.rows[0]?.opted_out || leadState.rows[0]?.automation_unresponsive) return false;

  const stepsResult = await query(
    'SELECT delay_minutes FROM automation_sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC',
    [sequenceId]
  );
  if (!stepsResult.rows.length) return false;

  const inserted = await query(
    `INSERT INTO automation_enrollments (tenant_id, lead_id, sequence_id, rule_id, current_step, status, next_send_at)
     VALUES ($1, $2, $3, $4, 0, 'active', NOW() + ($5 || ' minutes')::INTERVAL)
     ON CONFLICT (tenant_id, lead_id, sequence_id) DO NOTHING
     RETURNING id`,
    [tenantId, leadId, sequenceId, ruleId, stepsResult.rows[0].delay_minutes]
  );
  if (!inserted.rows.length) return false; // already enrolled — no new activity

  const sequenceResult = await query('SELECT name FROM automation_sequences WHERE id = $1', [sequenceId]);
  const sequenceName = sequenceResult.rows[0]?.name || 'Automation';
  const totalSteps = stepsResult.rows.length;

  let ruleName = 'Assignment rule';
  let triggerLabel = 'Lead assigned via assignment rule';
  if (ruleId) {
    const ruleResult = await query(
      'SELECT name, trigger_type, stage_name, source_value, status_value FROM automation_rules WHERE id = $1',
      [ruleId]
    );
    const rule = ruleResult.rows[0];
    if (rule) {
      ruleName = rule.name;
      triggerLabel = ruleTriggerLabel(rule);
    }
  }

  await query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
     VALUES ($1, $2, 'automation_triggered', $3, $4)`,
    [tenantId, leadId, sequenceName, `Rule: ${ruleName} (${triggerLabel})`]
  ).catch(() => {});

  await query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
     VALUES ($1, $2, 'sequence_started', $3, $4)`,
    [tenantId, leadId, sequenceName, `Step 1 of ${totalSteps}`]
  ).catch(() => {});

  return true;
};

// Cancels every active enrollment for a lead, across all sequences. Shared by
// opt-out, stop-on-reply, and lost-stage cancellation — the reason is recorded
// for reporting/debugging, and logged to the lead's Activity timeline per sequence.
const cancelActiveEnrollments = async ({ tenantId, leadId, reason }) => {
  const cancelled = await query(
    `UPDATE automation_enrollments SET status = 'cancelled', cancelled_at = NOW(), cancelled_reason = $3
     WHERE tenant_id = $1 AND lead_id = $2 AND status IN ('active','blocked','failed','uncertain','human_review','awaiting_reply')
     RETURNING id, sequence_id`,
    [tenantId, leadId, reason]
  );
  if (!cancelled.rows.length) return;

  const REASON_LABELS = { opted_out: 'Lead opted out', replied: 'Lead replied', stage_lost: 'Lead marked Lost' };
  for (const row of cancelled.rows) {
    const sequenceResult = await query('SELECT name FROM automation_sequences WHERE id = $1', [row.sequence_id]);
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
       VALUES ($1, $2, 'automation_cancelled', $3, $4)`,
      [tenantId, leadId, sequenceResult.rows[0]?.name || 'Automation', REASON_LABELS[reason] || reason]
    ).catch(() => {});
  }
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

  // A product-specific new-lead rule is more specific than generic escalation
  // or campaign rules. Legacy precedence is unchanged when no product rule matches.
  const productRules=await query(`SELECT r.id,r.sequence_id FROM automation_rules r JOIN leads l ON l.id=$2 AND l.tenant_id=r.tenant_id
    WHERE r.tenant_id=$1 AND r.trigger_type='new_lead' AND r.is_active=true AND NULLIF(trim(r.product_interest),'') IS NOT NULL
    AND lower(trim(r.product_interest))=lower(trim(l.product))`,[tenantId,lead.id]);
  if(productRules.rows.length){for(const rule of productRules.rows)await enrollLead({tenantId,leadId:lead.id,sequenceId:rule.sequence_id,ruleId:rule.id});return;}
  const escalated = await escalateInsteadOfAutomate({ tenantId, lead });
  if (escalated) return;

  if (lead.campaign_id) {
    const campaignRules = await query(
      `SELECT id, sequence_id FROM automation_rules
       WHERE tenant_id = $1 AND trigger_type = 'campaign' AND campaign_id = $2 AND is_active = true
       AND (NULLIF(trim(product_interest),'') IS NULL OR lower(trim(product_interest))=(SELECT lower(trim(product)) FROM leads WHERE id=$3 AND tenant_id=$1))`,
      [tenantId, lead.campaign_id,lead.id]
    );
    if (campaignRules.rows.length) {
      for (const rule of campaignRules.rows) {
        await enrollLead({ tenantId, leadId: lead.id, sequenceId: rule.sequence_id, ruleId: rule.id });
      }
      return;
    }
  }

  if (lead.source) {
    const sourceRules = await query(
      `SELECT id, sequence_id FROM automation_rules
       WHERE tenant_id = $1 AND trigger_type = 'lead_source' AND is_active = true
         AND LOWER(source_value) = LOWER($2)
         AND (NULLIF(trim(product_interest),'') IS NULL OR lower(trim(product_interest))=(SELECT lower(trim(product)) FROM leads WHERE id=$3 AND tenant_id=$1))`,
      [tenantId, lead.source,lead.id]
    );
    for (const rule of sourceRules.rows) {
      await enrollLead({ tenantId, leadId: lead.id, sequenceId: rule.sequence_id, ruleId: rule.id });
    }
  }

  const rules = await query(
    `SELECT id, sequence_id FROM automation_rules
     WHERE tenant_id = $1 AND trigger_type = 'new_lead' AND is_active = true AND NULLIF(trim(product_interest),'') IS NULL`,
    [tenantId]
  );
  for (const rule of rules.rows) {
    await enrollLead({ tenantId, leadId: lead.id, sequenceId: rule.sequence_id, ruleId: rule.id });
  }
};

// Called when a lead's lead_status field is changed (human-driven updateLead).
// A lead can match multiple lead_status rules over time as its status changes;
// enrollLead's unique constraint still prevents double-enrolling the same
// lead into the same sequence twice.
const checkLeadStatusTriggers = async ({ tenantId, leadId, newStatus }) => {
  if (!leadId || !newStatus) return;

  const rules = await query(
    `SELECT id, sequence_id FROM automation_rules
     WHERE tenant_id = $1 AND trigger_type = 'lead_status' AND is_active = true
       AND LOWER(status_value) = LOWER($2)
       AND (NULLIF(trim(product_interest),'') IS NULL OR lower(trim(product_interest))=(SELECT lower(trim(product)) FROM leads WHERE id=$3 AND tenant_id=$1))`,
    [tenantId, newStatus,leadId]
  );
  for (const rule of rules.rows) {
    await enrollLead({ tenantId, leadId, sequenceId: rule.sequence_id, ruleId: rule.id });
  }
};

// Called from every stage-change path (human-driven updateLead, AI-driven changeLeadStage).
// A lead moving into a lost stage has any active enrollments cancelled rather than
// enrolled further — no point nurturing a dead lead.
const checkStageChangeTriggers = async ({ tenantId, leadId, newStage, isLost = false, isWon = false }) => {
  if (!leadId || !newStage) return;

  if (isLost) {
    await cancelActiveEnrollments({ tenantId, leadId, reason: 'stage_lost' });
    return;
  }

  if (isWon) {
    sendReviewRequest({ tenantId, leadId }).catch(() => {});
  }

  const rules = await query(
    `SELECT id, sequence_id FROM automation_rules
     WHERE tenant_id = $1 AND trigger_type = 'stage_change' AND is_active = true
       AND LOWER(stage_name) = LOWER($2)
       AND (NULLIF(trim(product_interest),'') IS NULL OR lower(trim(product_interest))=(SELECT lower(trim(product)) FROM leads WHERE id=$3 AND tenant_id=$1))`,
    [tenantId, newStage,leadId]
  );
  for (const rule of rules.rows) {
    await enrollLead({ tenantId, leadId, sequenceId: rule.sequence_id, ruleId: rule.id });
  }
};

module.exports = { checkNewLeadTriggers, checkStageChangeTriggers, checkLeadStatusTriggers, enrollLead, cancelActiveEnrollments };
