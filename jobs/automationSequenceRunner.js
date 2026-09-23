const { query } = require('../config/db');
const { sendTextMessage, sendTemplate, listMessageTemplates } = require('../services/whatsappService');
const { sendEmail } = require('../utils/email');
const { substituteVars } = require('../utils/templateVars');
const { isSessionOpen } = require('../utils/sessionWindow');
const { generateFollowUpMessage } = require('../services/groqService');

// v1 limitation: business hours are compared against server time, not a
// per-tenant timezone — documented, not solved, until tenants can set a timezone.
const isWithinBusinessHours = (settings, now) => {
  if (!settings.automation_business_hours_enabled) return true;
  const hhmm = now.toISOString().slice(11, 16);
  const start = settings.automation_business_hours_start || '09:00';
  const end = settings.automation_business_hours_end || '20:00';
  return hhmm >= start && hhmm < end;
};

const nextBusinessWindowStart = (settings, now) => {
  const start = settings.automation_business_hours_start || '09:00';
  const end = settings.automation_business_hours_end || '20:00';
  const hhmm = now.toISOString().slice(11, 16);
  const [h, m] = start.split(':').map(Number);
  const next = new Date(now);
  next.setUTCHours(h, m, 0, 0);
  if (hhmm >= end) next.setUTCDate(next.getUTCDate() + 1);
  return next;
};

const runAutomationSequences = async () => {
  try {
    const due = await query(`
      SELECT e.id AS enrollment_id, e.tenant_id, e.lead_id, e.sequence_id, e.current_step, e.enrolled_at,
             l.name, l.phone, l.email, l.location, l.source,
             t.name AS tenant_name, t.email AS tenant_email, t.settings AS tenant_settings
      FROM automation_enrollments e
      JOIN leads l ON l.id = e.lead_id
      JOIN tenants t ON t.id = e.tenant_id
      WHERE e.status = 'active' AND e.next_send_at <= NOW()
        AND l.opted_out = false AND l.automation_unresponsive = false
    `);

    for (const row of due.rows) {
      try {
        const settings = row.tenant_settings || {};
        const now = new Date();

        if (!isWithinBusinessHours(settings, now)) {
          await query('UPDATE automation_enrollments SET next_send_at = $1 WHERE id = $2',
            [nextBusinessWindowStart(settings, now), row.enrollment_id]);
          continue;
        }

        if (settings.automation_daily_cap_enabled) {
          const cap = settings.automation_daily_cap || 1;
          const sentToday = await query(
            `SELECT COUNT(*) FROM whatsapp_messages
             WHERE lead_id = $1 AND is_automated = true AND sent_at >= CURRENT_DATE`,
            [row.lead_id]
          );
          if (parseInt(sentToday.rows[0].count, 10) >= cap) {
            await query(`UPDATE automation_enrollments SET next_send_at = NOW() + INTERVAL '1 day' WHERE id = $1`, [row.enrollment_id]);
            continue;
          }
        }

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
        let message = substituteVars(step.message, lead);

        if (step.channel === 'whatsapp' && row.phone) {
          const credentials = settings.whatsapp_phone_number_id && settings.whatsapp_access_token
            ? { phone_number_id: settings.whatsapp_phone_number_id, access_token: settings.whatsapp_access_token }
            : null;

          const sessionOpen = await isSessionOpen(row.lead_id);

          let aiGeneratedSend = false;
          let aiFailed = false;
          if (sessionOpen && step.ai_generated) {
            const historyResult = await query(
              `SELECT direction, message FROM whatsapp_messages WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 10`,
              [row.lead_id]
            );
            const aiMessage = await generateFollowUpMessage({
              leadName: row.name,
              tenantName: row.tenant_name,
              businessDescription: settings.business_description,
              instructions: step.ai_instructions,
              conversationHistory: historyResult.rows.reverse(),
            });
            if (aiMessage) { message = aiMessage; aiGeneratedSend = true; }
            else aiFailed = true;
          }

          if (sessionOpen && aiFailed) {
            // AI call failed or returned empty — ai_instructions is guidance
            // text, not customer-facing, so never send it raw. Skip this tick
            // and flag it, same pattern as the no-approved-template skip below.
            await query(
              `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
               VALUES ($1,$2,'automation_ai_failed','Automated message skipped',
                       'AI follow-up generation failed or returned empty for this step; nothing was sent this cycle.')`,
              [row.tenant_id, row.lead_id]
            ).catch(() => {});
          } else if (sessionOpen) {
            const sendResult = await sendTextMessage(row.phone, message, credentials);
            await query(
              `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status, is_automated, is_ai_generated)
               VALUES ($1,$2,'outbound',$3,'text',$4,$5,true,$6)`,
              [row.tenant_id, row.lead_id, message, sendResult.wa_message_id, sendResult.success ? 'sent' : 'failed', aiGeneratedSend]
            ).catch(() => {});
            await query(
              `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
               VALUES ($1,$2,'automated_whatsapp',$3,$4)`,
              [row.tenant_id, row.lead_id, aiGeneratedSend ? 'Automated message sent (AI-personalized)' : 'Automated message sent', message]
            ).catch(() => {});
          } else if (step.approved_template_name) {
            // Templates aren't always registered under 'en' — Meta's own template
            // creator commonly defaults to 'en_US', and this WABA has a mix of both.
            // Sending with the wrong language code fails outright (Meta error 132001,
            // "template name does not exist in <lang>"), so resolve the template's
            // actual language before sending rather than assuming. Falls back to 'en'
            // if the lookup fails (network issue) or the template isn't found there —
            // same as the previous hardcoded behavior, not a regression.
            let language = 'en';
            const templateList = await listMessageTemplates(
              settings.whatsapp_business_account_id, credentials?.access_token || settings.whatsapp_access_token
            ).catch(() => null);
            const matchedTemplate = templateList?.success
              ? templateList.templates.find(t => t.name === step.approved_template_name)
              : null;
            if (matchedTemplate) language = matchedTemplate.language;

            // Templates with a body variable (e.g. "Hi {{1}}") reject a send with
            // zero parameters outright (Meta error 132000). Fill every {{n}} slot
            // with the lead's name — covers the near-universal single-variable
            // "Hi {{1}}" greeting case; templates with multiple distinct variables
            // would need per-step parameter mapping, which isn't built yet.
            const bodyComponent = matchedTemplate?.components?.find(c => c.type === 'BODY');
            const varCount = bodyComponent ? (bodyComponent.text.match(/\{\{\d+\}\}/g) || []).length : 0;
            const parameters = varCount > 0
              ? Array(varCount).fill({ type: 'text', text: row.name || 'there' })
              : [];

            // A template can have a video/image/document header registered via the
            // Broadcast feature (whatsapp_template_media, keyed by template name) —
            // look it up so automation sends carry the same media a manual broadcast
            // send would, instead of silently dropping it.
            const media = await query(
              `SELECT media_type, media_url FROM whatsapp_template_media
               WHERE tenant_id = $1 AND template_name = $2 AND language = $3`,
              [row.tenant_id, step.approved_template_name, language]
            );
            const headerMedia = media.rows[0]
              ? { type: media.rows[0].media_type.toLowerCase(), link: media.rows[0].media_url }
              : null;
            const sendResult = await sendTemplate(row.phone, step.approved_template_name, language, parameters, credentials, headerMedia);
            await query(
              `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, template_name, wa_message_id, status, is_automated)
               VALUES ($1,$2,'outbound',$3,'template',$4,$5,$6,true)`,
              [row.tenant_id, row.lead_id, `[Template: ${step.approved_template_name}]`, step.approved_template_name,
                sendResult.wa_message_id, sendResult.success ? 'sent' : 'failed']
            ).catch(() => {});
            await query(
              `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
               VALUES ($1,$2,'automated_whatsapp','Automated template sent',$3)`,
              [row.tenant_id, row.lead_id, `Template: ${step.approved_template_name}`]
            ).catch(() => {});
          } else {
            // 24h session window closed and no approved template configured for this
            // step — WhatsApp will reject free text here, so skip sending rather than
            // risk it, and flag it for a human to fix (add a template to the step).
            await query(
              `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
               VALUES ($1,$2,'automation_template_required','Automated message skipped',
                       'WhatsApp session window closed and no approved template configured for this step.')`,
              [row.tenant_id, row.lead_id]
            ).catch(() => {});
          }
        } else if (step.channel === 'email' && row.email) {
          const subject = substituteVars(step.email_subject || `Message from ${row.tenant_name || 'us'}`, lead);
          const replyTo = row.tenant_settings?.email_reply_to || row.tenant_email || undefined;
          await sendEmail({ to: row.email, subject, text: message, fromName: row.tenant_name, replyTo });
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
          const nextSendAt = await query(
            `UPDATE automation_enrollments
             SET current_step = current_step + 1, next_send_at = NOW() + ($1 || ' minutes')::INTERVAL
             WHERE id = $2 RETURNING next_send_at`,
            [nextStep.delay_minutes, row.enrollment_id]
          );
          const nextActionLabel = nextStep.channel === 'email' ? 'Email' : 'WhatsApp Message';
          await query(
            `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, metadata)
             VALUES ($1,$2,'automation_next_scheduled','Follow-up Scheduled',$3,$4)`,
            [
              row.tenant_id, row.lead_id, `Next Action: ${nextActionLabel}`,
              JSON.stringify({ next_action_at: nextSendAt.rows[0].next_send_at }),
            ]
          ).catch(() => {});
        } else {
          // Sequence finished — if the lead never replied throughout it, mark them
          // unresponsive so no further automation (any sequence) is attempted.
          const replied = await query(
            `SELECT 1 FROM whatsapp_messages WHERE lead_id = $1 AND direction = 'inbound' AND sent_at > $2 LIMIT 1`,
            [row.lead_id, row.enrolled_at]
          );
          if (!replied.rows.length) {
            await query('UPDATE leads SET automation_unresponsive = true WHERE id = $1', [row.lead_id]);
          }
          await query(`UPDATE automation_enrollments SET status = 'completed', completed_at = NOW() WHERE id = $1`, [row.enrollment_id]);
          const sequenceResult = await query('SELECT name FROM automation_sequences WHERE id = $1', [row.sequence_id]);
          await query(
            `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
             VALUES ($1,$2,'sequence_completed',$3,$4)`,
            [row.tenant_id, row.lead_id, sequenceResult.rows[0]?.name || 'Automation', `Completed ${steps.rows.length} of ${steps.rows.length} steps`]
          ).catch(() => {});
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
