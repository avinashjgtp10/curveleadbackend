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
  } catch (e) {
    console.error('[ReminderJob] Error:', e.message);
  }
};

module.exports = { runFollowupReminder };
