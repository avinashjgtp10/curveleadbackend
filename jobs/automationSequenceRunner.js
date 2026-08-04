const { query } = require('../config/db');
const { sendTextMessage } = require('../services/whatsappService');
const { sendEmail } = require('../utils/email');
const { substituteVars } = require('../utils/templateVars');

const runAutomationSequences = async () => {
  try {
    const due = await query(`
      SELECT e.id AS enrollment_id, e.tenant_id, e.lead_id, e.sequence_id, e.current_step,
             l.name, l.phone, l.email, l.location, l.source,
             t.name AS tenant_name, t.settings AS tenant_settings
      FROM automation_enrollments e
      JOIN leads l ON l.id = e.lead_id
      JOIN tenants t ON t.id = e.tenant_id
      WHERE e.status = 'active' AND e.next_send_at <= NOW()
    `);

    for (const row of due.rows) {
      try {
        const steps = await query(
          'SELECT * FROM automation_sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC',
          [row.sequence_id]
        );
        const step = steps.rows[row.current_step];

        // Sequence was edited/shortened out from under this enrollment — nothing left to send.
        if (!step) {
          await query(`UPDATE automation_enrollments SET status = 'completed', completed_at = NOW() WHERE id = $1`, [row.enrollment_id]);
          continue;
        }

        const lead = { name: row.name, phone: row.phone, email: row.email, location: row.location, source: row.source };
        const message = substituteVars(step.message, lead);

        if (step.channel === 'whatsapp' && row.phone) {
          const settings = row.tenant_settings || {};
          const credentials = settings.whatsapp_phone_number_id && settings.whatsapp_access_token
            ? { phone_number_id: settings.whatsapp_phone_number_id, access_token: settings.whatsapp_access_token }
            : null;
          const sendResult = await sendTextMessage(row.phone, message, credentials);
          await query(
            `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status)
             VALUES ($1,$2,'outbound',$3,'text',$4,$5)`,
            [row.tenant_id, row.lead_id, message, sendResult.wa_message_id, sendResult.success ? 'sent' : 'failed']
          ).catch(() => {});
        } else if (step.channel === 'email' && row.email) {
          const subject = substituteVars(step.email_subject || `Message from ${row.tenant_name || 'us'}`, lead);
          await sendEmail({ to: row.email, subject, text: message, fromName: row.tenant_name });
          await query(
            `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
             VALUES ($1,$2,'email',$3,$4)`,
            [row.tenant_id, row.lead_id, subject, message]
          ).catch(() => {});
        }
        // No phone for a whatsapp step, or no email for an email step: silently skip
        // delivery but still advance, so the enrollment doesn't get stuck retrying forever.

        const nextStep = steps.rows[row.current_step + 1];
        if (nextStep) {
          await query(
            `UPDATE automation_enrollments
             SET current_step = current_step + 1, next_send_at = NOW() + ($1 || ' minutes')::INTERVAL
             WHERE id = $2`,
            [nextStep.delay_minutes, row.enrollment_id]
          );
        } else {
          await query(`UPDATE automation_enrollments SET status = 'completed', completed_at = NOW() WHERE id = $1`, [row.enrollment_id]);
        }
      } catch (stepError) {
        console.error('[AutomationRunner] step error:', stepError.message);
      }
    }

    if (due.rows.length > 0) {
      console.log(`[AutomationRunner] Processed ${due.rows.length} due step(s)`);
    }
  } catch (e) {
    console.error('[AutomationRunner] Error:', e.message);
  }
};

module.exports = { runAutomationSequences };
