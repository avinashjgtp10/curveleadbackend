const { query } = require('../config/db');
const { active } = require('../services/followupSummary');
const { bookingSettings, sendBookingMessage } = require('../services/bookingMessages');

// A reminder is sent when its time comes due, within this window. Later than that
// (server was down, or the booking was made after the reminder time) it's skipped
// rather than sent late, e.g. no "1 day before" reminder for a visit booked 3h ahead.
const GRACE_MS = 20 * 60 * 1000;
// Don't send a reminder this soon after the booking was made — the confirmation covers it.
const MIN_AFTER_BOOKING_MS = 60 * 60 * 1000;

let running = false;

// Sends WhatsApp reminders to leads before their demo/visit. Runs every 5 minutes;
// booking_messages' unique key makes each reminder go out at most once per booking time.
const runBookingReminders = async () => {
  if (running) return;
  running = true;
  try {
    const { rows } = await query(
      `SELECT f.id, f.next_followup_at, f.created_at, t.settings->'booking_messages' AS cfg
       FROM lead_followups f
       JOIN leads l ON l.id = f.lead_id AND l.tenant_id = f.tenant_id
       JOIN tenants t ON t.id = f.tenant_id
       WHERE ${active}
         AND f.followup_type IN ('demo', 'visit')
         AND f.notify_lead = true
         AND (t.settings->'booking_messages'->>'reminders_enabled')::boolean IS TRUE
         AND f.next_followup_at > NOW() AND f.next_followup_at <= NOW() + INTERVAL '8 days'
       ORDER BY f.next_followup_at`
    );

    const now = Date.now();
    let sent = 0;
    for (const row of rows) {
      const cfg = bookingSettings({ booking_messages: row.cfg });
      const at = new Date(row.next_followup_at).getTime();
      for (const kind of ['reminder_1', 'reminder_2']) {
        const minutes = Number(cfg[`${kind}_minutes`]);
        if (!(minutes > 0)) continue;
        const dueAt = at - minutes * 60 * 1000;
        if (now < dueAt || now - dueAt > GRACE_MS) continue;
        if (dueAt - new Date(row.created_at).getTime() < MIN_AFTER_BOOKING_MS) continue;
        const result = await sendBookingMessage(row.id, kind);
        if (result.sent) sent++;
      }
    }
    if (sent) console.log(`[BookingReminders] Sent ${sent} reminder(s)`);
  } catch (e) {
    // 42P01/42703: migration_booking_messages.sql hasn't been run yet — nothing to do.
    if (!['42P01', '42703'].includes(e.code)) console.error('runBookingReminders:', e.message);
  } finally {
    running = false;
  }
};

module.exports = { runBookingReminders };
