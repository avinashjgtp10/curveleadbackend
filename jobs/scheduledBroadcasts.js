const { query } = require('../config/db');
const { executeBroadcast } = require('../controllers/whatsappBroadcastController');

let running = false;

// Sends every scheduled WhatsApp broadcast that has come due. Runs every minute;
// a large broadcast can take longer than that, so overlapping runs are skipped.
const runScheduledBroadcasts = async () => {
  if (running) return;
  running = true;
  try {
    // A row stuck in 'sending' means the server restarted mid-send. Don't resend
    // (some leads already got it) — mark it failed so it's visible.
    await query(
      `UPDATE whatsapp_scheduled_broadcasts SET status = 'failed', error = 'Interrupted by a server restart', completed_at = NOW()
       WHERE status = 'sending' AND started_at < NOW() - INTERVAL '1 hour'`
    );

    for (;;) {
      const claimed = await query(
        `UPDATE whatsapp_scheduled_broadcasts SET status = 'sending', started_at = NOW()
         WHERE id = (SELECT id FROM whatsapp_scheduled_broadcasts
                     WHERE status = 'pending' AND scheduled_at <= NOW()
                     ORDER BY scheduled_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING *`
      );
      const job = claimed.rows[0];
      if (!job) break;

      try {
        const { sent, failed } = await executeBroadcast({
          tenantId: job.tenant_id, userId: job.created_by, lead_ids: job.lead_ids,
          template_name: job.template_name, language_code: job.language_code,
          body_text: job.body_text, mapping: job.variable_mapping || [],
        });
        await query(
          `UPDATE whatsapp_scheduled_broadcasts SET status = 'sent', sent_count = $2, failed_count = $3, completed_at = NOW() WHERE id = $1`,
          [job.id, sent, failed]
        );
        console.log(`✅ Scheduled broadcast ${job.id}: ${sent} sent, ${failed} failed`);
      } catch (e) {
        console.error('Scheduled broadcast failed:', job.id, e.message);
        await query(
          `UPDATE whatsapp_scheduled_broadcasts SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
          [job.id, e.message.slice(0, 500)]
        );
      }
    }
  } catch (e) {
    // 42P01: migration_scheduled_broadcasts.sql hasn't been run yet — nothing to do.
    if (e.code !== '42P01') console.error('runScheduledBroadcasts:', e.message);
  } finally {
    running = false;
  }
};

module.exports = { runScheduledBroadcasts };
