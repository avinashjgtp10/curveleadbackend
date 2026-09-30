const { transaction } = require("../config/db");
const pickRoundRobinMember = (members, last) =>
  members.length
    ? members[(members.findIndex((m) => m.id === last) + 1) % members.length]
    : null;
const matchesRule = (r, l) =>
  (!r.sources?.length || r.sources.includes(l.source)) &&
  (!r.campaign_ids?.length || r.campaign_ids.includes(l.campaign_id)) &&
  (!r.location_contains ||
    (l.city || l.location || "")
      .toLowerCase()
      .includes(r.location_contains.toLowerCase()));
async function assignInTransaction(client, tenantId, lead) {
  if (!lead?.id || lead.assigned_to) return lead;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `assignment:${tenantId}`,
  ]);
  const current = (
    await client.query(
      "SELECT assigned_to FROM leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [lead.id, tenantId],
    )
  ).rows[0];
  if (!current || current.assigned_to) return lead;
  const rules = (
    await client.query(
      "SELECT * FROM assignment_rules WHERE tenant_id=$1 AND is_active=true ORDER BY priority,created_at,id",
      [tenantId],
    )
  ).rows;
  let target, chosen;
  for (const rule of rules) {
    if (!matchesRule(rule, lead)) continue;
    const members = (
      await client.query(
        `SELECT id,name FROM users WHERE tenant_id=$1 AND is_active=true AND
      (id=$2 OR team_id=$3 OR id=ANY($4::uuid[])) ORDER BY created_at,id`,
        [
          tenantId,
          rule.assign_to_user_id,
          rule.assign_to_team_id,
          rule.staff_ids || [],
        ],
      )
    ).rows;
    target = pickRoundRobinMember(members, rule.last_assigned_user_id);
    chosen = rule;
    break; // First matching rule owns the decision; an unavailable target uses fallback.
  }
  if (!target) {
    target = (
      await client.query(
        `SELECT u.id,u.name FROM tenants t JOIN users u ON u.id::text=t.settings->>'assignment_fallback_id' AND u.tenant_id=t.id AND u.is_active=true WHERE t.id=$1`,
        [tenantId],
      )
    ).rows[0];
    chosen = null;
  }
  if (!target) return lead;
  await client.query(
    "UPDATE leads SET assigned_to=$1 WHERE id=$2 AND tenant_id=$3",
    [target.id, lead.id, tenantId],
  );
  if (chosen)
    await client.query(
      "UPDATE assignment_rules SET last_assigned_user_id=$1 WHERE id=$2 AND tenant_id=$3",
      [target.id, chosen.id, tenantId],
    );
  await client.query(
    `INSERT INTO lead_activities(tenant_id,lead_id,activity_type,title) VALUES($1,$2,'assignment',$3)`,
    [
      tenantId,
      lead.id,
      `Assigned to ${target.name} by rule ${chosen?.name || "Fallback"}`,
    ],
  );
  await client.query(
    `INSERT INTO notifications(tenant_id,user_id,title,message,type,reference_type,reference_id) VALUES($1,$2,'New lead assigned to you',$3,'assignment','lead',$4)`,
    [tenantId, target.id, lead.name, lead.id],
  );
  if (chosen?.sequence_id && !lead.opted_out && !lead.automation_unresponsive) {
    await client.query(
      `INSERT INTO automation_enrollments(tenant_id,lead_id,sequence_id,current_step,status,next_send_at)
      SELECT $1,$2,$3,0,'active',now()+(delay_minutes*interval '1 minute') FROM automation_sequence_steps WHERE sequence_id=$3 ORDER BY step_order LIMIT 1
      ON CONFLICT(tenant_id,lead_id,sequence_id) DO NOTHING`,
      [tenantId, lead.id, chosen.sequence_id],
    );
  }
  return { ...lead, assigned_to: target.id };
}
const applyAssignmentRules = ({ tenantId, lead }) =>
  transaction((client) => assignInTransaction(client, tenantId, lead));
module.exports = {
  pickRoundRobinMember,
  matchesRule,
  assignInTransaction,
  applyAssignmentRules,
};
