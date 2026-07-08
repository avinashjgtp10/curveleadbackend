const { query } = require('../config/db');
const { createNotification } = require('../controllers/notificationController');
const {
  TARGET_RESPONSE_MINUTES, ESCALATION_AFTER_MINUTES, REASSIGN_AFTER_MINUTES, MISSED_AFTER_MINUTES,
  AUTO_REASSIGN_ENABLED,
} = require('../utils/leadSla');

// Each tier below fires a given notification type at most ONCE per lead — the guard is
// "has this type ever been sent for this lead", not a time window (unlike followupReminder.js's
// recurring reminders): once a lead is contacted, first_response_at IS NULL stops matching any
// tier, and each tier only needs to speak up once before the next, more urgent tier takes over.
const runLeadSlaMonitor = async () => {
  try {
    await notifyAssigneeAtRisk();
    await escalateToAdmins();
    await flagMissedLeads();
    if (AUTO_REASSIGN_ENABLED) await autoReassignStale();
  } catch (e) {
    console.error('[LeadSlaMonitor] Error:', e.message);
  }
};

// Tier 1 — notify the assignee once the lead crosses the target response window
async function notifyAssigneeAtRisk() {
  const result = await query(`
    SELECT l.id, l.tenant_id, l.name, l.assigned_to
    FROM leads l
    WHERE l.first_response_at IS NULL
      AND l.assigned_to IS NOT NULL
      AND l.created_at <= NOW() - INTERVAL '${TARGET_RESPONSE_MINUTES} minutes'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.tenant_id = l.tenant_id AND n.type = 'sla_risk' AND n.reference_id = l.id
      )
  `);
  for (const l of result.rows) {
    await createNotification(
      l.tenant_id, l.assigned_to, `SLA at risk — ${l.name}`,
      'Still uncontacted 5+ minutes after creation', 'sla_risk', 'lead', l.id
    );
  }
  if (result.rows.length > 0) console.log(`[LeadSlaMonitor] Sent ${result.rows.length} sla_risk notification(s)`);
}

// Tier 2 — escalate to all active tenant admins once the lead crosses the escalation window
async function escalateToAdmins() {
  const result = await query(`
    SELECT l.id, l.tenant_id, l.name
    FROM leads l
    WHERE l.first_response_at IS NULL
      AND l.created_at <= NOW() - INTERVAL '${ESCALATION_AFTER_MINUTES} minutes'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.tenant_id = l.tenant_id AND n.type = 'sla_escalated' AND n.reference_id = l.id
      )
  `);
  let sent = 0;
  for (const l of result.rows) {
    const admins = await query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`, [l.tenant_id]);
    for (const admin of admins.rows) {
      await createNotification(
        l.tenant_id, admin.id, `SLA escalation — ${l.name}`,
        `Still uncontacted 15+ minutes after creation.`, 'sla_escalated', 'lead', l.id
      );
      sent++;
    }
  }
  if (sent > 0) console.log(`[LeadSlaMonitor] Sent ${sent} sla_escalated notification(s)`);
}

// Tier 3 — flag as missed to all active tenant admins once the lead crosses 24h
async function flagMissedLeads() {
  const result = await query(`
    SELECT l.id, l.tenant_id, l.name
    FROM leads l
    WHERE l.first_response_at IS NULL
      AND l.created_at <= NOW() - INTERVAL '${MISSED_AFTER_MINUTES} minutes'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.tenant_id = l.tenant_id AND n.type = 'sla_missed' AND n.reference_id = l.id
      )
  `);
  let sent = 0;
  for (const l of result.rows) {
    const admins = await query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`, [l.tenant_id]);
    for (const admin of admins.rows) {
      await createNotification(
        l.tenant_id, admin.id, `Lead missed — ${l.name}`,
        '24+ hours with no response.', 'sla_missed', 'lead', l.id
      );
      sent++;
    }
  }
  if (sent > 0) console.log(`[LeadSlaMonitor] Sent ${sent} sla_missed notification(s)`);
}

// Tier 4 (optional, off by default) — reassign to the least-loaded eligible staff member
async function autoReassignStale() {
  const result = await query(`
    SELECT l.id, l.tenant_id, l.name, l.assigned_to
    FROM leads l
    WHERE l.first_response_at IS NULL
      AND l.assigned_to IS NOT NULL
      AND l.created_at <= NOW() - INTERVAL '${REASSIGN_AFTER_MINUTES} minutes'
      AND NOT EXISTS (
        SELECT 1 FROM lead_activities a WHERE a.lead_id = l.id AND a.activity_type = 'sla_auto_reassigned'
      )
  `);
  let reassigned = 0;
  for (const l of result.rows) {
    const candidate = await query(`
      SELECT u.id FROM users u
      WHERE u.tenant_id = $1 AND u.role = 'staff' AND u.is_active = true AND u.id != $2
      ORDER BY (
        SELECT COUNT(*) FROM leads
        WHERE assigned_to = u.id AND LOWER(stage) NOT IN (
          SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND (is_won = true OR is_lost = true)
        )
      ) ASC
      LIMIT 1
    `, [l.tenant_id, l.assigned_to]);
    const newAssignee = candidate.rows[0]?.id;
    if (!newAssignee) continue; // no eligible candidate — skip silently

    await query('UPDATE leads SET assigned_to = $1 WHERE id = $2', [newAssignee, l.id]);
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title)
       VALUES ($1, $2, 'sla_auto_reassigned', 'Auto-reassigned due to no response')`,
      [l.tenant_id, l.id]
    );
    await createNotification(l.tenant_id, newAssignee, `Lead reassigned to you — ${l.name}`, 'Previous assignee did not respond in time.', 'sla_reassigned', 'lead', l.id);
    await createNotification(l.tenant_id, l.assigned_to, `Lead reassigned away — ${l.name}`, 'No response within 30 minutes.', 'sla_reassigned_away', 'lead', l.id);
    reassigned++;
  }
  if (reassigned > 0) console.log(`[LeadSlaMonitor] Auto-reassigned ${reassigned} lead(s)`);
}

module.exports = { runLeadSlaMonitor };
