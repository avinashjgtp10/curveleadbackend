const axios = require('axios');
const { query } = require('../config/db');
const { uploadToS3 } = require('../config/s3');
const { sendTextMessage, sendTemplate, sendMediaMessage } = require('../services/whatsappService');
const { qualifyLead } = require('../services/groqService');
const { recordFirstResponse } = require('../utils/leadResponse');
const { changeLeadStage } = require('../utils/leadStage');
const { resolveWhatsAppCredentials, findNumberOwner, findTenantBySharedNumber } = require('../utils/whatsappCredentials');
const { nextLeadNumber } = require('../utils/leadNumber');
const { resolveCampaignFromAdId } = require('../utils/metaCampaignMatch');
const { applyAssignmentRules } = require('../utils/leadAssignment');
const { notifyNewLead } = require('../utils/leadNotifyEmail');
const { checkNewLeadTriggers, cancelActiveEnrollments } = require('../utils/automationTriggers');
const { createNotification } = require('./notificationController');
const { isOptOutMessage } = require('../utils/optOut');
const { substituteVars } = require('../utils/templateVars');
const { isWithinBusinessHours } = require('../utils/businessHours');

const INBOUND_MEDIA_TYPES = { image: 'image', document: 'document', audio: 'audio', video: 'video', sticker: 'image' };

// Meta's media URLs need the WABA access token as a Bearer header and expire
// quickly, so inbound media is fetched once here and re-hosted on our own S3 —
// same approach as outbound attachments — rather than storing Meta's URL directly.
const downloadWhatsAppMedia = async (mediaId, accessToken) => {
  const meta = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const file = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer',
  });
  return { buffer: Buffer.from(file.data), mimeType: meta.data.mime_type };
};

// Resolves an inbound webhook message into what we actually store/show: a
// readable text (button/list taps get their real label, not "[button]"), and
// for media messages, our own re-hosted URL plus the WhatsApp message_type.
const resolveInboundContent = async ({ msg, tenantId, assignedTo }) => {
  if (msg.text?.body) return { text: msg.text.body, mediaUrl: null, messageType: 'text' };
  if (msg.button?.text) return { text: msg.button.text, mediaUrl: null, messageType: 'text' };
  if (msg.interactive?.button_reply?.title) return { text: msg.interactive.button_reply.title, mediaUrl: null, messageType: 'text' };
  if (msg.interactive?.list_reply?.title) return { text: msg.interactive.list_reply.title, mediaUrl: null, messageType: 'text' };

  const waType = INBOUND_MEDIA_TYPES[msg.type];
  if (waType && msg[msg.type]?.id) {
    const media = msg[msg.type];
    try {
      const credentials = await resolveWhatsAppCredentials(tenantId, assignedTo);
      if (!credentials?.access_token) throw new Error('No WhatsApp access token configured for this tenant.');
      const { buffer, mimeType } = await downloadWhatsAppMedia(media.id, credentials.access_token);
      const ext = (mimeType || '').split('/')[1]?.split(';')[0] || 'bin';
      const key = `whatsapp-inbound/${tenantId}/${Date.now()}-${media.id}.${ext}`;
      const mediaUrl = await uploadToS3(buffer, key, mimeType || 'application/octet-stream');
      return { text: media.caption || media.filename || `[${waType}]`, mediaUrl, messageType: waType };
    } catch (e) {
      console.error('Failed to fetch inbound WhatsApp media:', e.message);
      return { text: media.caption || `[${waType} — could not be downloaded]`, mediaUrl: null, messageType: waType };
    }
  }

  return { text: `[${msg.type}]`, mediaUrl: null, messageType: 'text' };
};

// GET /api/whatsapp/inbox - Shared team inbox (all conversations)
const getInbox = async (req, res) => {
  try {
    const { search, unread_only } = req.query;
    let where = 'WHERE wm.tenant_id = $1';
    const params = [req.tenantId];
    if (req.user.role === 'staff') { where += ' AND l.assigned_to = $2'; params.push(req.user.id); }

    // Group by lead, get latest message per lead
    const result = await query(
      `SELECT DISTINCT ON (wm.lead_id)
              wm.lead_id, wm.message, wm.direction, wm.sent_at, wm.status,
              l.name as lead_name, l.phone as lead_phone, l.lead_score, l.stage, COALESCE(l.tags, '{}') as tags,
              u.name as assigned_to_name,
              (SELECT COUNT(*) FROM whatsapp_messages WHERE lead_id = wm.lead_id AND direction = 'inbound' AND read_at IS NULL) as unread_count
       FROM whatsapp_messages wm
       JOIN leads l ON wm.lead_id = l.id
       LEFT JOIN users u ON l.assigned_to = u.id
       ${where}
       ORDER BY wm.lead_id, wm.sent_at DESC
       LIMIT 100`,
      params
    );

    // Sort by most recent
    const conversations = result.rows.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
    res.json({ conversations });
  } catch (error) {
    console.error('Get inbox error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/whatsapp/labels { lead_id, add?: string[], remove?: string[] }
// Chat labels are the lead's tags, so they persist and are shared with the whole team.
const clean = (arr, max) => [...new Set((Array.isArray(arr) ? arr : []).map(x => String(x).trim().slice(0, 30)).filter(Boolean))].slice(0, max);
const updateChatLabels = async (req, res) => {
  try {
    const { lead_id } = req.body;
    const add = clean(req.body.add, 10);
    const remove = clean(req.body.remove, 20);
    if (!lead_id) return res.status(400).json({ error: 'lead_id required.' });
    if (!add.length && !remove.length) return res.status(400).json({ error: 'Nothing to change.' });

    const params = [lead_id, req.tenantId, add, remove];
    let scope = '';
    if (req.user.role === 'staff') { scope = ' AND assigned_to = $5'; params.push(req.user.id); }
    const result = await query(
      `UPDATE leads SET tags = ARRAY(
         SELECT DISTINCT x FROM unnest(COALESCE(tags, '{}') || $3::text[]) x WHERE x <> ALL($4::text[]) ORDER BY x)
       WHERE id = $1 AND tenant_id = $2${scope} RETURNING tags`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found.' });
    res.json({ tags: result.rows[0].tags || [] });
  } catch (error) {
    console.error('Update labels error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/whatsapp/conversation/:leadId - Get message thread for a lead
const getConversation = async (req, res) => {
  try {
    if (req.user.role === 'staff') {
      const owned = await query('SELECT 1 FROM leads WHERE id = $1 AND tenant_id = $2 AND assigned_to = $3', [req.params.leadId, req.tenantId, req.user.id]);
      if (!owned.rows.length) return res.status(404).json({ error: 'Lead not found.' });
    }
    const result = await query(
      `SELECT wm.*, u.name as sent_by_name
       FROM whatsapp_messages wm
       LEFT JOIN users u ON wm.sent_by = u.id
       WHERE wm.lead_id = $1 AND wm.tenant_id = $2
       ORDER BY wm.sent_at ASC`,
      [req.params.leadId, req.tenantId]
    );

    // Mark inbound messages as read
    await query(
      `UPDATE whatsapp_messages SET read_at = NOW(), status = 'read'
       WHERE lead_id = $1 AND tenant_id = $2 AND direction = 'inbound' AND read_at IS NULL`,
      [req.params.leadId, req.tenantId]
    );

    res.json({ messages: result.rows });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

const ATTACHMENT_TYPE_TO_MESSAGE_TYPE = { image: 'image', pdf: 'document', doc: 'document', audio: 'audio', video: 'video', other: 'document' };

// POST /api/whatsapp/send-attachment - Send an already-uploaded lead attachment as a
// real WhatsApp media message (image/document/audio/video), instead of a wa.me link.
const sendAttachment = async (req, res) => {
  try {
    const { lead_id, attachment_id } = req.body;
    if (!lead_id || !attachment_id) return res.status(400).json({ error: 'lead_id and attachment_id required.' });

    const leadResult = await query('SELECT phone, name, assigned_to FROM leads WHERE id = $1 AND tenant_id = $2', [lead_id, req.tenantId]);
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });
    const lead = leadResult.rows[0];
    if (req.user.role === 'staff' && lead.assigned_to !== req.user.id) return res.status(404).json({ error: 'Lead not found.' });
    if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number.' });

    const attResult = await query('SELECT file_name, file_url, file_type FROM lead_attachments WHERE id = $1 AND lead_id = $2 AND tenant_id = $3', [attachment_id, lead_id, req.tenantId]);
    if (attResult.rows.length === 0) return res.status(404).json({ error: 'Attachment not found.' });
    const att = attResult.rows[0];

    const credentials = await resolveWhatsAppCredentials(req.tenantId, lead.assigned_to);
    const result = await sendMediaMessage(lead.phone, att.file_type, att.file_url, att.file_name, credentials);

    const saved = await query(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, media_url, wa_message_id, status, sent_by)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.tenantId, lead_id, att.file_name,
        ATTACHMENT_TYPE_TO_MESSAGE_TYPE[att.file_type] || 'document', att.file_url,
        result.wa_message_id, result.success ? 'sent' : 'failed', req.user.id,
      ]
    );

    if (result.success) {
      await query('UPDATE leads SET last_contacted_at = NOW(), ai_paused = true WHERE id = $1', [lead_id]);
      recordFirstResponse(req.tenantId, lead_id, { by: req.user.id, type: 'whatsapp' }).catch(() => {});
    }

    if (!result.success) return res.status(502).json({ error: result.error || 'Failed to send file on WhatsApp.', message: saved.rows[0] });
    res.status(201).json({ message: saved.rows[0], delivery: result });
  } catch (error) {
    console.error('Send attachment error:', error);
    res.status(500).json({ error: 'Failed to send file.' });
  }
};

// POST /api/whatsapp/send - Send a message to a lead
const sendMessage = async (req, res) => {
  try {
    const { lead_id, message, template_name } = req.body;
    if (!lead_id || (!message && !template_name)) {
      return res.status(400).json({ error: 'lead_id and message required.' });
    }

    const leadResult = await query('SELECT phone, name, assigned_to FROM leads WHERE id = $1 AND tenant_id = $2', [lead_id, req.tenantId]);
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const lead = leadResult.rows[0];
    if (req.user.role === 'staff' && lead.assigned_to !== req.user.id) return res.status(404).json({ error: 'Lead not found.' });
    const credentials = await resolveWhatsAppCredentials(req.tenantId, lead.assigned_to);
    const result = template_name
      ? await sendTemplate(lead.phone, template_name, 'en', [], credentials)
      : await sendTextMessage(lead.phone, message, credentials);

    // Save to DB regardless of send success (for dev mode)
    const saved = await query(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status, sent_by)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.tenantId, lead_id, message || `[Template: ${template_name}]`,
        template_name ? 'template' : 'text',
        result.wa_message_id, result.success ? 'sent' : 'failed', req.user.id,
      ]
    );

    // Update lead's last contacted, and pause AI auto-reply now that a human has taken over
    await query('UPDATE leads SET last_contacted_at = NOW(), ai_paused = true WHERE id = $1', [lead_id]);
    recordFirstResponse(req.tenantId, lead_id, { by: req.user.id, type: 'whatsapp' }).catch(() => {});

    res.status(201).json({ message: saved.rows[0], delivery: result });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// A Click-to-WhatsApp ad's first message includes a `referral` block with the
// ad ID that drove the conversation — the same attribution signal lead-gen
// forms get via campaign_id, just delivered inside the message webhook
// instead of a separate leadgen event. Resolves it to a campaign (via the
// tenant's connected ad account, if any) and creates the lead.
const createLeadFromWhatsAppReferral = async ({ tenantId, fromPhone, contactName, referral }) => {
  const existing = await query('SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, fromPhone]);
  if (existing.rows.length) return null; // race with another inbound message — let the next iteration handle it

  const matched = await resolveCampaignFromAdId({ tenantId, adId: referral.source_id });
  const leadNumber = await nextLeadNumber(tenantId);
  const notesParts = ['Started via Click-to-WhatsApp ad.'];
  if (referral.headline) notesParts.push(`Ad headline: ${referral.headline}`);
  if (matched?.adName) notesParts.push(`Ad: ${matched.adName}`);

  const inserted = await query(
    `INSERT INTO leads (tenant_id, lead_number, name, phone, source, source_detail, campaign_id, meta_ad_id, stage, notes)
     VALUES ($1, $2, $3, $4, 'whatsapp', $5, $6, $7, 'new', $8) RETURNING *`,
    [
      tenantId, leadNumber, contactName || 'Unknown', fromPhone,
      matched?.adName || referral.headline || null,
      matched?.campaignId || null, referral.source_id, notesParts.join('\n'),
    ]
  );
  const lead = inserted.rows[0];

  applyAssignmentRules({ tenantId, lead }).then(() => notifyNewLead({ tenantId, lead })).catch(() => {});
  checkNewLeadTriggers({ tenantId, lead }).catch(() => {});

  console.log(`✅ WhatsApp lead captured from ad: ${lead.name} (${fromPhone}) for tenant ${tenantId}`);
  return lead;
};

// POST /api/whatsapp/webhook - Receive incoming messages from Meta
const handleWebhook = async (req, res) => {
  // Verification (GET)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // Always 200 OK for Meta
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];

    // Delivery receipts for our own outbound messages — sent/delivered/read/failed —
    // arrive here separately from inbound messages, keyed by the wa_message_id we
    // stored when we sent it.
    const statuses = change?.value?.statuses;
    if (statuses) {
      for (const s of statuses) {
        const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
        if (s.status === 'delivered') {
          await query(`UPDATE whatsapp_messages SET status='delivered', delivered_at=$1 WHERE wa_message_id=$2`, [at, s.id]).catch(() => {});
        } else if (s.status === 'read') {
          await query(`UPDATE whatsapp_messages SET status='read', read_at=$1 WHERE wa_message_id=$2`, [at, s.id]).catch(() => {});
        } else if (s.status === 'failed') {
          await query(`UPDATE whatsapp_messages SET status='failed' WHERE wa_message_id=$1`, [s.id]).catch(() => {});
        }
      }
    }

    const messages = change?.value?.messages;
    if (!messages) return;

    // Which of our numbers this message arrived on — the tenant's shared number,
    // or a specific rep's own connected number.
    const receivingNumberId = change?.value?.metadata?.phone_number_id;
    const numberOwner = await findNumberOwner(receivingNumberId);
    const contacts = change?.value?.contacts || [];

    for (const msg of messages) {
      const fromPhone = msg.from; // e.g. "919876543210"
      const waMessageId = msg.id;

      // If the message arrived on a rep's own number, scope the lookup to their
      // tenant. Otherwise fall back to matching by phone across all tenants
      // (shared tenant-level number, or a number we don't recognize).
      const leadResult = numberOwner
        ? await query(
            'SELECT id, tenant_id, name, assigned_to, ai_paused, opted_out, source, source_detail FROM leads WHERE tenant_id = $1 AND (phone = $2 OR phone = $3) LIMIT 1',
            [numberOwner.tenant_id, fromPhone, fromPhone.replace(/^91/, '')]
          )
        : await query(
            'SELECT id, tenant_id, name, assigned_to, ai_paused, opted_out, source, source_detail FROM leads WHERE phone = $1 OR phone = $2 LIMIT 1',
            [fromPhone, fromPhone.replace(/^91/, '')]
          );

      let lead = leadResult.rows[0] || null;

      if (!lead) {
        // Unknown number — only auto-create a lead if this conversation started
        // from a Click-to-WhatsApp ad, so it can be attributed to a campaign.
        // Organic messages from unrecognized numbers are still dropped.
        const referral = msg.referral;
        if (referral?.source_type === 'ad' && referral.source_id) {
          const tenantId = numberOwner?.tenant_id || await findTenantBySharedNumber(receivingNumberId);
          if (tenantId) {
            const contactName = contacts.find(c => c.wa_id === fromPhone)?.profile?.name;
            lead = await createLeadFromWhatsAppReferral({ tenantId, fromPhone, contactName, referral });
          }
        }
      }

      if (!lead) {
        console.log(`Unknown WhatsApp number: ${fromPhone}`);
        continue;
      }

      // A message landing on a rep's personal number implicitly claims the lead for them.
      if (numberOwner && !lead.assigned_to) {
        await query('UPDATE leads SET assigned_to = $1 WHERE id = $2', [numberOwner.id, lead.id]);
        lead.assigned_to = numberOwner.id;
      }

      // Resolve what to actually store: button/list taps get their real label
      // instead of "[button]", and media gets downloaded and re-hosted on our S3.
      const { text: messageText, mediaUrl, messageType } = await resolveInboundContent({ msg, tenantId: lead.tenant_id, assignedTo: lead.assigned_to });

      // Save inbound message
      await query(
        `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, media_url, wa_message_id, status, sent_at)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, 'delivered', NOW())`,
        [lead.tenant_id, lead.id, messageText, messageType, mediaUrl, waMessageId]
      );

      // A reply from the lead means any drip sequence has done its job — stop it.
      // If the reply is actually an opt-out request, stop everything permanently
      // instead and record it, rather than treating it as a normal reply.
      if (isOptOutMessage(messageText)) {
        await query('UPDATE leads SET opted_out = true, opted_out_at = NOW() WHERE id = $1', [lead.id]);
        lead.opted_out = true;
        await cancelActiveEnrollments({ tenantId: lead.tenant_id, leadId: lead.id, reason: 'opted_out' });
        await query(
          `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title)
           VALUES ($1, $2, 'opted_out', 'Lead opted out of automated messages')`,
          [lead.tenant_id, lead.id]
        ).catch(() => {});
      } else {
        await cancelActiveEnrollments({ tenantId: lead.tenant_id, leadId: lead.id, reason: 'replied' });
      }

      // Get tenant settings to check if AI auto-reply is enabled
      const tenantResult = await query('SELECT settings, name FROM tenants WHERE id = $1', [lead.tenant_id]);
      const tenant = tenantResult.rows[0];
      const aiEnabled = tenant?.settings?.ai_qualification_enabled;

      // Away message: outside business hours, at most once per 12h per lead. If sent, the AI skips this turn.
      let awaySent = false;
      if (tenant?.settings?.whatsapp_away_enabled && tenant.settings.whatsapp_away_message && !lead.opted_out
          && !isWithinBusinessHours(tenant.settings.whatsapp_business_hours)) {
        try {
          const recent = await query(
            `SELECT 1 FROM whatsapp_messages WHERE lead_id = $1 AND direction = 'outbound' AND is_automated = true
               AND message = $2 AND sent_at > NOW() - INTERVAL '12 hours' LIMIT 1`,
            [lead.id, substituteVars(tenant.settings.whatsapp_away_message, lead)]
          );
          if (!recent.rows.length) {
            const awayText = substituteVars(tenant.settings.whatsapp_away_message, lead);
            const awayCreds = await resolveWhatsAppCredentials(lead.tenant_id, lead.assigned_to);
            const awayResult = await sendTextMessage(fromPhone, awayText, awayCreds);
            await query(
              `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status, is_automated)
               VALUES ($1, $2, 'outbound', $3, 'text', $4, $5, true)`,
              [lead.tenant_id, lead.id, awayText, awayResult.wa_message_id, awayResult.success ? 'sent' : 'failed']
            );
            awaySent = awayResult.success;
          }
        } catch (e) { console.error('Away message failed:', e.message); }
      }

      if (aiEnabled && !awaySent && !lead.ai_paused && !lead.opted_out) {
        try {
          // Get recent messages for context
          const historyResult = await query(
            `SELECT direction, message FROM whatsapp_messages WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 10`,
            [lead.id]
          );

          const aiResponse = await qualifyLead(
            lead.name,
            historyResult.rows.reverse(),
            messageText,
            {
              business_name: tenant.name, description: tenant.settings?.business_description,
              knowledge: tenant.settings?.ai_knowledge,
              lead_source: [lead.source, lead.source_detail].filter(Boolean).join(' — ') || null,
            }
          );

          // Send AI reply — from the assigned rep's own number if they have one
          const credentials = await resolveWhatsAppCredentials(lead.tenant_id, lead.assigned_to);
          const sendResult = await sendTextMessage(fromPhone, aiResponse.reply, credentials);
          await query(
            `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status, is_ai_generated)
             VALUES ($1, $2, 'outbound', $3, 'text', $4, $5, true)`,
            [lead.tenant_id, lead.id, aiResponse.reply, sendResult.wa_message_id, sendResult.success ? 'sent' : 'failed']
          );

          // The AI decided this lead should see a demo or pricing — send the file the
          // tenant configured for that action (WhatsApp Hub > AI Auto-reply), right
          // after the text reply. No-ops silently if nothing's configured for it.
          const shareFile = tenant.settings?.ai_share_files?.[aiResponse.suggested_action];
          if (shareFile?.url) {
            const mediaResult = await sendMediaMessage(fromPhone, shareFile.file_type, shareFile.url, shareFile.name, credentials);
            await query(
              `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, media_url, wa_message_id, status, is_automated, is_ai_generated)
               VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, true, true)`,
              [
                lead.tenant_id, lead.id, shareFile.name, ATTACHMENT_TYPE_TO_MESSAGE_TYPE[shareFile.file_type] || 'document',
                shareFile.url, mediaResult.wa_message_id, mediaResult.success ? 'sent' : 'failed',
              ]
            );
          }

          // The lead just gave a specific date/time for a call/demo/visit — book it
          // automatically instead of leaving it sitting in the chat transcript, and
          // let the team know it's confirmed. Sanity-checked against a plausible
          // window so a hallucinated date/time can't create garbage appointments.
          const bookingAt = aiResponse.booking?.ready && aiResponse.booking?.date_time_iso ? new Date(aiResponse.booking.date_time_iso) : null;
          const bookingIsPlausible = bookingAt && !isNaN(bookingAt.getTime())
            && bookingAt.getTime() > Date.now() - 60 * 60 * 1000
            && bookingAt.getTime() < Date.now() + 365 * 24 * 60 * 60 * 1000;
          if (bookingIsPlausible) {
            await query(
              `UPDATE lead_followups SET is_completed = true, completed_at = NOW() WHERE lead_id = $1 AND tenant_id = $2 AND is_completed = false`,
              [lead.id, lead.tenant_id]
            );
            await query(
              `INSERT INTO lead_followups (tenant_id, lead_id, notes, followup_type, next_followup_at)
               VALUES ($1, $2, $3, 'demo', $4)`,
              [lead.tenant_id, lead.id, aiResponse.booking.summary || 'Booked automatically by AI Auto-reply.', aiResponse.booking.date_time_iso]
            );
            const demoTime = bookingAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
            await query(
              `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
               VALUES ($1, $2, 'demo_scheduled', 'Demo Scheduled', $3)`,
              [lead.tenant_id, lead.id, `Booked by AI for ${demoTime}.${aiResponse.booking.summary ? ' ' + aiResponse.booking.summary : ''}`]
            ).catch(() => {});
            const notifyTitle = `Demo confirmed — ${lead.name}`;
            const notifyBody = `Booked for ${demoTime} via AI Auto-reply.`;
            if (lead.assigned_to) {
              await createNotification(lead.tenant_id, lead.assigned_to, notifyTitle, notifyBody, 'demo_due', 'lead', lead.id).catch(() => {});
            } else {
              const admins = await query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`, [lead.tenant_id]);
              for (const admin of admins.rows) {
                await createNotification(lead.tenant_id, admin.id, notifyTitle, notifyBody, 'demo_due', 'lead', lead.id).catch(() => {});
              }
            }
          }

          // If the AI isn't confident it can handle this (unclear intent, complaint,
          // urgent request), hand off to a human instead of continuing automation.
          if (aiResponse.should_human_takeover) {
            await query('UPDATE leads SET ai_paused = true WHERE id = $1', [lead.id]);
            const title = `AI handoff needed — ${lead.name}`;
            const body = messageText.substring(0, 100);
            if (lead.assigned_to) {
              await createNotification(lead.tenant_id, lead.assigned_to, title, body, 'ai_handoff', 'lead', lead.id);
            } else {
              const admins = await query(
                `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`,
                [lead.tenant_id]
              );
              for (const admin of admins.rows) {
                await createNotification(lead.tenant_id, admin.id, title, body, 'ai_handoff', 'lead', lead.id);
              }
            }
          }

          // Update lead based on AI intent
          if (aiResponse.intent === 'not_interested') {
            const lostStage = await query(
              `SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_lost = true AND is_active = true LIMIT 1`,
              [lead.tenant_id]
            );
            if (lostStage.rows.length) {
              await changeLeadStage({
                tenantId: lead.tenant_id, leadId: lead.id,
                newStageName: lostStage.rows[0].name, lostReason: 'AI: Lead marked not interested',
              });
            }
          } else if (aiResponse.intent === 'ready_to_buy') {
            await query(`UPDATE leads SET lead_score = 'hot' WHERE id = $1`, [lead.id]);
            await changeLeadStage({ tenantId: lead.tenant_id, leadId: lead.id, newStageName: 'Qualified' });
          }
        } catch (e) {
          console.error('AI auto-reply failed:', e.message);
        }
      }

      // Notify assigned user
      if (lead.assigned_to) {
        await query(
          `INSERT INTO notifications (tenant_id, user_id, title, message, type, reference_type, reference_id)
           VALUES ($1, $2, $3, $4, 'whatsapp', 'lead', $5)`,
          [lead.tenant_id, lead.assigned_to, `New message from ${lead.name}`, messageText.substring(0, 100), lead.id]
        );
      }
    }
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
  }
};

module.exports = { getInbox, getConversation, sendMessage, sendAttachment, handleWebhook, updateChatLabels };
