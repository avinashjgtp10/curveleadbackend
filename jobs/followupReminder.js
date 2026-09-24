const { query } = require('../config/db');
const { createNotification } = require('../controllers/notificationController');

const runFollowupReminder = async () => {
  try {
    // Find incomplete follow-ups that are overdue or due within 30 min,
    // but haven't had a notification sent in the last 2 hours for that lead + user combo
    const result = await query(`
      SELECT
        f.id,
        f.tenant_id,
        f.lead_id,
        f.followup_type,
        f.next_followup_at,
        l.name AS lead_name,
        COALESCE(l.assigned_to, f.created_by) AS notify_user_id
      FROM lead_followups f
      JOIN leads l ON f.lead_id = l.id
      WHERE f.is_completed = false
        AND f.next_followup_at <= NOW() + INTERVAL '30 minutes'
        AND COALESCE(l.assigned_to, f.created_by) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.tenant_id    = f.tenant_id
            AND n.user_id      = COALESCE(l.assigned_to, f.created_by)
            AND n.type         IN ('followup_due', 'demo_due')
            AND n.reference_id = f.lead_id
            AND n.created_at   > NOW() - INTERVAL '2 hours'
        )
      ORDER BY f.next_followup_at ASC
    `);

    for (const f of result.rows) {
      const isOverdue = new Date(f.next_followup_at) < new Date();
      const isDemo    = f.followup_type === 'demo';
      const label     = isDemo ? 'Demo' : 'Follow-up';

      const title   = isOverdue
        ? `${label} overdue — ${f.lead_name}`
        : `${label} due soon — ${f.lead_name}`;
      const message = new Date(f.next_followup_at).toLocaleString('en-IN', {
        dateStyle: 'medium', timeStyle: 'short',
      });

      await createNotification(
        f.tenant_id,
        f.notify_user_id,
        title,
        message,
        isDemo ? 'demo_due' : 'followup_due',
        'lead',
        f.lead_id,
      );
    }

    if (result.rows.length > 0) {
      console.log(`[ReminderJob] Sent ${result.rows.length} follow-up notification(s)`);
    }

    // Escalate to admins: followups overdue by more than 2 hours with no recent escalation
    const escalations = await query(`
      SELECT DISTINCT
        f.tenant_id,
        f.lead_id,
        l.name AS lead_name,
        COALESCE(l.assigned_to, f.created_by) AS assigned_user_id
      FROM lead_followups f
      JOIN leads l ON f.lead_id = l.id
      WHERE f.is_completed = false
        AND f.next_followup_at < NOW() - INTERVAL '2 hours'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.tenant_id  = f.tenant_id
            AND n.type       = 'escalation'
            AND n.reference_id = f.lead_id
            AND n.created_at > NOW() - INTERVAL '4 hours'
        )
    `);

    for (const esc of escalations.rows) {
      const admins = await query(
        `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`,
        [esc.tenant_id]
      );
      for (const admin of admins.rows) {
        await createNotification(
          esc.tenant_id,
          admin.id,
          `Follow-up overdue — ${esc.lead_name}`,
          `More than 2 hours overdue. Assigned user has not yet completed the follow-up.`,
          'escalation',
          'lead',
          esc.lead_id,
        );
      }
    }

    if (escalations.rows.length > 0) {
      console.log(`[ReminderJob] Sent escalation for ${escalations.rows.length} overdue lead(s)`);
    }

    // Leads that have never had a follow-up scheduled at all (no lead_followups row,
    // or all of them completed) and have sat untouched for 48h+. Everything above only
    // catches a follow-up that IS scheduled and overdue — a lead nobody ever touched a
    // second time falls through all of it silently. Escalates once per day per lead
    // until someone schedules a follow-up or updates the lead.
    const NO_FOLLOWUP_AFTER_HOURS = 48;
    const noFollowup = await query(`
      SELECT l.id AS lead_id, l.tenant_id, l.name AS lead_name, l.assigned_to
      FROM leads l
      LEFT JOIN lead_stages ls ON LOWER(ls.name) = LOWER(l.stage) AND ls.tenant_id = l.tenant_id
      WHERE COALESCE(ls.is_won, false) = false AND COALESCE(ls.is_lost, false) = false
        AND l.updated_at < NOW() - INTERVAL '${NO_FOLLOWUP_AFTER_HOURS} hours'
        AND NOT EXISTS (SELECT 1 FROM lead_followups f WHERE f.lead_id = l.id AND f.is_completed = false)
        AND NOT EXISTS (
          -- Dedup on our OWN write (lead_activities), not on whether a notification
          -- recipient existed — a lead with no assignee in a tenant with no active
          -- admin gets zero notifications ever, which made this guard never trip
          -- and re-flagged the lead on every 15-min tick forever.
          SELECT 1 FROM lead_activities a
          WHERE a.tenant_id = l.tenant_id AND a.lead_id = l.id AND a.activity_type = 'no_followup_scheduled'
            AND a.created_at > NOW() - INTERVAL '24 hours'
        )
    `);

    for (const lead of noFollowup.rows) {
      const title = `No follow-up scheduled — ${lead.lead_name}`;
      const body = 'No activity and no follow-up date set on this lead. Schedule a follow-up or update its stage.';

      if (lead.assigned_to) {
        await createNotification(lead.tenant_id, lead.assigned_to, title, body, 'no_followup_scheduled', 'lead', lead.lead_id);
      }
      const admins = await query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`, [lead.tenant_id]);
      for (const admin of admins.rows) {
        if (admin.id === lead.assigned_to) continue;
        await createNotification(lead.tenant_id, admin.id, title, body, 'no_followup_scheduled', 'lead', lead.lead_id);
      }
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
         VALUES ($1, $2, 'no_followup_scheduled', $3, $4)`,
        [lead.tenant_id, lead.lead_id, title, body]
      ).catch(() => {});
    }

    if (noFollowup.rows.length > 0) {
      console.log(`[ReminderJob] Flagged ${noFollowup.rows.length} lead(s) with no follow-up ever scheduled`);
    }
  } catch (e) {
    console.error('[ReminderJob] Error:', e.message);
  }
};

module.exports = { runFollowupReminder };
