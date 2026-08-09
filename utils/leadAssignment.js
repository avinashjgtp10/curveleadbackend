const { query } = require('../config/db');
const { createNotification } = require('../controllers/notificationController');
const { enrollLead } = require('./automationTriggers');

// Picks the next team member in round-robin order, cycling past whoever was
// assigned last time. Falls back to the first (oldest) member if the cursor
// is unset or no longer on the team.
const pickRoundRobinMember = (members, lastAssignedUserId) => {
  if (!members.length) return null;
  const lastIdx = members.findIndex(m => m.id === lastAssignedUserId);
  return members[(lastIdx + 1) % members.length];
};

// Called from every lead-creation path, right after the lead is inserted.
// No-ops if the lead already has an assignee (staff-created leads, or leads
// where the caller explicitly picked someone) or no rule matches.
const applyAssignmentRules = async ({ tenantId, lead }) => {
  if (!lead?.id || lead.assigned_to) return;

  const rules = await query(
    `SELECT * FROM assignment_rules
     WHERE tenant_id = $1 AND is_active = true
     ORDER BY priority ASC, created_at ASC`,
    [tenantId]
  );

  for (const rule of rules.rows) {
    if (rule.sources?.length && !rule.sources.includes(lead.source)) continue;
    if (rule.campaign_ids?.length && !rule.campaign_ids.includes(lead.campaign_id)) continue;
    if (rule.location_contains && !(lead.location || '').toLowerCase().includes(rule.location_contains.toLowerCase())) continue;

    let targetUserId = null;

    if (rule.assign_to_user_id) {
      const userCheck = await query(
        'SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND is_active = true',
        [rule.assign_to_user_id, tenantId]
      );
      if (userCheck.rows.length) targetUserId = rule.assign_to_user_id;
    } else if (rule.assign_to_team_id) {
      const members = await query(
        `SELECT id FROM users WHERE tenant_id = $1 AND team_id = $2 AND is_active = true ORDER BY created_at ASC`,
        [tenantId, rule.assign_to_team_id]
      );
      const picked = pickRoundRobinMember(members.rows, rule.last_assigned_user_id);
      if (picked) targetUserId = picked.id;
    }

    if (!targetUserId) continue; // rule matched but has no valid target — try the next rule

    const updated = await query(
      `UPDATE leads SET assigned_to = $1 WHERE id = $2 AND tenant_id = $3 AND assigned_to IS NULL RETURNING id`,
      [targetUserId, lead.id, tenantId]
    );
    if (!updated.rows.length) return; // already assigned by something else in the meantime

    if (rule.assign_to_team_id) {
      await query('UPDATE assignment_rules SET last_assigned_user_id = $1 WHERE id = $2', [targetUserId, rule.id]);
    }

    createNotification(
      tenantId, targetUserId, 'New lead assigned to you',
      `${lead.name} — respond within 5 minutes to hit SLA`,
      'assignment', 'lead', lead.id
    ).catch(() => {});

    if (rule.sequence_id) {
      await enrollLead({ tenantId, leadId: lead.id, sequenceId: rule.sequence_id, ruleId: null }).catch(() => {});
    }

    return;
  }
};

module.exports = { applyAssignmentRules };
