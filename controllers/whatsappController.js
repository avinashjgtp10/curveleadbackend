const { ingestLead } = require('../services/leadIngestion');
const { normalizePhone, phoneDigitVariants } = require('../utils/dataQuality');
const { getWorkspaceLocale } = require('../utils/workspaceLocale');
const axios = require('axios');
const { query } = require('../config/db');
const { uploadToS3 } = require('../config/s3');
const { sendTextMessage, sendTemplate, sendMediaMessage, listMessageTemplates } = require('../services/whatsappService');
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
const { isOptOutMessage, isOptInMessage } = require('../utils/optOut');
const { recordOptIn, checkTemplateConsent } = require('../services/whatsappConsent');
const { shouldPauseAi, isRepeatOf, MAX_AUTOMATED_AI_TURNS } = require('../services/autoReplyGuard');
const { substituteVars } = require('../utils/templateVars');
const { isWithinBusinessHours } = require('../utils/businessHours');
const { isSessionOpen } = require('../utils/sessionWindow');
const { GRAPH_URL } = require('../config/meta');

const INBOUND_MEDIA_TYPES = { image: 'image', document: 'document', audio: 'audio', video: 'video', sticker: 'image' };

// Meta's media URLs need the WABA access token as a Bearer header and expire
// quickly, so inbound media is fetched once here and re-hosted on our own S3 —
// same approach as outbound attachments — rather than storing Meta's URL directly.
const downloadWhatsAppMedia = async (mediaId, accessToken) => {
  const meta = await axios.get(`${GRAPH_URL}/${mediaId}`, {
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

    // Latest message per lead, then the 100 most recently active conversations.
    // DISTINCT ON must order by lead_id, so the recency limit is applied outside
    // it — limiting inside would keep an arbitrary 100 by UUID order.
    const result = await query(
      `SELECT c.lead_id, c.message, c.direction, c.sent_at, c.status,
              l.name as lead_name, l.phone as lead_phone, l.lead_score, l.stage, COALESCE(l.tags, '{}') as tags,
              l.assigned_to, u.name as assigned_to_name, l.ai_paused, l.custom_fields,
              (SELECT MAX(sent_at) FROM whatsapp_messages WHERE lead_id = c.lead_id AND direction = 'inbound') as last_inbound_at,
              (SELECT COUNT(*) FROM whatsapp_messages WHERE lead_id = c.lead_id AND direction = 'inbound' AND read_at IS NULL) as unread_count
       FROM (
         SELECT DISTINCT ON (wm.lead_id) wm.lead_id, wm.message, wm.direction, wm.sent_at, wm.status
         FROM whatsapp_messages wm
         JOIN leads l ON wm.lead_id = l.id
         ${where}
         ORDER BY wm.lead_id, wm.sent_at DESC
       ) c
       JOIN leads l ON l.id = c.lead_id
       LEFT JOIN users u ON l.assigned_to = u.id
       ORDER BY c.sent_at DESC NULLS LAST
       LIMIT 100`,
      params
    );

    const conversations = result.rows;
    const tenantRow = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
    res.json({ conversations, ai_enabled: !!tenantRow.rows[0]?.settings?.ai_qualification_enabled });
  } catch (error) {
    console.error('Get inbox error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// DELETE /api/whatsapp/conversations { lead_ids: [...] } — bulk-delete whole
// chat histories. Staff can only delete conversations for leads assigned to them.
const deleteConversations = async (req, res) => {
  try {
    const leadIds = Array.isArray(req.body.lead_ids) ? [...new Set(req.body.lead_ids)].filter(Boolean) : [];
    if (!leadIds.length) return res.status(400).json({ error: 'lead_ids required.' });
    if (leadIds.length > 200) return res.status(400).json({ error: 'Max 200 conversations at a time.' });

    const params = [req.tenantId, leadIds];
    let scope = '';
    if (req.user.role === 'staff') {
      scope = ' AND lead_id IN (SELECT id FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL AND assigned_to = $3)';
      params.push(req.user.id);
    }
    const result = await query(
      `DELETE FROM whatsapp_messages WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[])${scope}`,
      params
    );
    res.json({ deleted_messages: result.rowCount });
  } catch (error) {
    console.error('Delete conversations error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// PUT /api/whatsapp/conversations/read { lead_ids: [...] } — bulk mark-as-read,
// same effect opening each chat individually would have.
const markConversationsRead = async (req, res) => {
  try {
    const leadIds = Array.isArray(req.body.lead_ids) ? [...new Set(req.body.lead_ids)].filter(Boolean) : [];
    if (!leadIds.length) return res.status(400).json({ error: 'lead_ids required.' });
    if (leadIds.length > 200) return res.status(400).json({ error: 'Max 200 conversations at a time.' });

    const params = [req.tenantId, leadIds];
    let scope = '';
    if (req.user.role === 'staff') {
      scope = ' AND lead_id IN (SELECT id FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL AND assigned_to = $3)';
      params.push(req.user.id);
    }
    await query(
      `UPDATE whatsapp_messages SET read_at = NOW(), status = 'read'
       WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[]) AND direction = 'inbound' AND read_at IS NULL${scope}`,
      params
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Mark conversations read error:', error);
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

// POST /api/whatsapp/send - Send a message to a lead. Free text only works inside
// WhatsApp's 24h customer-service window; outside it the caller must send an approved
// template ({ template_name, language_code, template_params, body_text }).
const sendMessage = async (req, res) => {
  try {
    const { lead_id, message, template_name, language_code, template_params, body_text } = req.body;
    if (!lead_id || (!message && !template_name)) {
      return res.status(400).json({ error: 'lead_id and message required.' });
    }

    const leadResult = await query('SELECT phone, name, assigned_to, opted_out FROM leads WHERE id = $1 AND tenant_id = $2', [lead_id, req.tenantId]);
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const lead = leadResult.rows[0];
    if (req.user.role === 'staff' && lead.assigned_to !== req.user.id) return res.status(404).json({ error: 'Lead not found.' });

    if (!template_name && !(await isSessionOpen(lead_id))) {
      return res.status(409).json({
        error: 'The 24-hour WhatsApp window is closed for this lead. Send an approved template to restart the conversation.',
        window_closed: true,
      });
    }
    if (template_name && lead.opted_out) {
      return res.status(409).json({ error: 'This lead has opted out of WhatsApp messages.' });
    }

    const credentials = await resolveWhatsAppCredentials(req.tenantId, lead.assigned_to);

    let result, storedText, headerMedia = null;
    if (template_name) {
      const lang = language_code || 'en_US';
      const settings=(await query('SELECT settings FROM tenants WHERE id=$1',[req.tenantId])).rows[0]?.settings || {};
      const templates=await listMessageTemplates(settings.whatsapp_business_account_id,settings.whatsapp_access_token);
      const approved=templates.templates?.find(t=>t.name===template_name&&t.language===lang&&t.status==='APPROVED');
      if(!approved)return res.status(422).json({error:'Approved template unavailable.'});
      const consent = await checkTemplateConsent({ tenantId: req.tenantId, leadId: lead_id, template: approved });
      if (!consent.allowed) return res.status(409).json({ error: consent.reason, consent_required: true, category: consent.category });
      const templateBody=approved.components?.find(c=>c.type==='BODY')?.text || '';
      const params = Array.isArray(template_params) ? template_params.map(p => String(p ?? '')) : [];
      const mediaRow = (await query(
        'SELECT media_type, media_url FROM whatsapp_template_media WHERE tenant_id = $1 AND template_name = $2 AND language = $3',
        [req.tenantId, template_name, lang]
      )).rows[0];
      headerMedia = mediaRow ? { type: mediaRow.media_type.toLowerCase(), link: mediaRow.media_url } : null;

      if(params.length!==Math.max(0,...[...templateBody.matchAll(/\{\{(\d+)\}\}/g)].map(m=>Number(m[1]))))return res.status(422).json({error:'Map every template variable.'});
      result = await sendTemplate(lead.phone, template_name, lang, params.map(text => ({ type: 'text', text })), credentials, headerMedia);
      storedText = templateBody;
      params.forEach((p, i) => { storedText = storedText.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), () => p); });
    } else {
      result = await sendTextMessage(lead.phone, message, credentials);
      storedText = message;
    }

    // Save to DB regardless of send success so the failure is visible in the chat
    const saved = await query(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, media_url, template_name, wa_message_id, status, sent_by)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.tenantId, lead_id, storedText,
        template_name ? 'template' : 'text', headerMedia?.link || null, template_name || null,
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

// PUT /api/whatsapp/conversation/:leadId/ai { paused } - Take over from / hand back to the AI
const setConversationAi = async (req, res) => {
  try {
    const { paused } = req.body;
    const leadResult = await query('SELECT assigned_to FROM leads WHERE id = $1 AND tenant_id = $2', [req.params.leadId, req.tenantId]);
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });
    if (req.user.role === 'staff' && leadResult.rows[0].assigned_to !== req.user.id) return res.status(404).json({ error: 'Lead not found.' });

    await query('UPDATE leads SET ai_paused = $1 WHERE id = $2 AND tenant_id = $3', [!!paused, req.params.leadId, req.tenantId]);
    res.json({ ai_paused: !!paused });
  } catch (error) {
    console.error('Set conversation AI error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/whatsapp/start-chat { phone, name } — message someone who isn't a
// lead yet. Reuses an existing lead if the phone already matches one (never
// creates a duplicate); otherwise creates a minimal lead so the rest of the
// app — the inbox thread, inbound replies, follow-ups — works exactly like any
// other lead from here on. Doesn't send anything itself; the caller sends via
// the normal /send or template flow once this returns the lead_id.
const startChat = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone, (await getWorkspaceLocale(req.tenantId)).country);
    const ingestion = await ingestLead(req.tenantId, { name: req.body.name || 'Unknown', phone, source: 'manual', stage: 'new', assigned_to: req.user.role === 'staff' ? req.user.id : null });
    const lead = ingestion.lead;
    if (req.user.role === 'staff' && lead.assigned_to !== req.user.id) return res.status(403).json({ error: 'This contact is assigned to another team member.' });
    const contact = { lead_id: lead.id, lead_name: lead.name, lead_phone: lead.phone, assigned_to: lead.assigned_to };
    if (ingestion.duplicate) return res.json({ ...contact, created: false });

    applyAssignmentRules({ tenantId: req.tenantId, lead }).then(() => notifyNewLead({ tenantId: req.tenantId, lead })).catch(() => {});
    checkNewLeadTriggers({ tenantId: req.tenantId, lead }).catch(() => {});

    res.status(201).json({ ...contact, created: true });
  } catch (error) {
    console.error('Start chat error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to start chat.' });
  }
};

// A Click-to-WhatsApp ad's first message includes a `referral` block with the
// ad ID that drove the conversation — the same attribution signal lead-gen
// forms get via campaign_id, just delivered inside the message webhook
// instead of a separate leadgen event. Resolves it to a campaign (via the
// tenant's connected ad account, if any) and creates the lead.
const createLeadFromWhatsAppReferral = async ({ tenantId, fromPhone, contactName, referral }) => {
  const matched = await resolveCampaignFromAdId({ tenantId, adId: referral.source_id });
  const notesParts = ['Started via Click-to-WhatsApp ad.'];
  if (referral.headline) notesParts.push(`Ad headline: ${referral.headline}`);
  if (matched?.adName) notesParts.push(`Ad: ${matched.adName}`);

  const ingestion = await ingestLead(tenantId, {
    name: contactName || 'Unknown', phone: fromPhone, source: 'whatsapp', source_detail: matched?.adName || referral.headline || null,
    campaign_id: matched?.campaignId || null, meta_ad_id: referral.source_id, stage: 'new', notes: notesParts.join('\n'),
  });
  const lead = ingestion.lead;
  if (ingestion.duplicate) return lead;

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

  const {webhookSecrets,verifyMetaWebhookAny}=require('../utils/metaWebhookSignature');
  const secrets=webhookSecrets();
  if (!secrets.length) return res.status(503).json({error:'Webhook verification is not configured.'});
  if (!verifyMetaWebhookAny(req.rawBody,req.headers['x-hub-signature-256'],secrets)) {
    // TEMPORARY: existing workspaces connect through their own Meta apps, whose
    // secrets we don't hold, so their webhooks can't be verified. Until they move
    // to the platform app via Embedded Signup, accept unsigned deliveries only for
    // phone numbers connected to a workspace. Set META_WEBHOOK_REQUIRE_SIGNATURE=true
    // to enforce signatures again.
    const numberIds=(req.body?.entry||[]).flatMap(e=>(e.changes||[]).map(c=>c.value?.metadata?.phone_number_id));
    const known=numberIds.length>0&&(await Promise.all(numberIds.map(async id=>!!(id&&((await findNumberOwner(id))||(await findTenantBySharedNumber(id))))))).every(Boolean);
    if (process.env.META_WEBHOOK_REQUIRE_SIGNATURE==='true'||!known) {
      console.warn('WhatsApp webhook rejected: signature matches no configured Meta app secret.');
      return res.status(401).json({error:'Invalid webhook signature.'});
    }
    console.warn(`WhatsApp webhook accepted without a verified signature for number ${numberIds.join(',')} (temporary bypass).`);
  }
  // Acknowledge authenticated Meta deliveries before processing.
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
          await query(`UPDATE whatsapp_messages SET status=CASE WHEN status='read' THEN 'read' ELSE 'delivered' END, delivered_at=COALESCE(delivered_at,$1) WHERE wa_message_id=$2`, [at, s.id]).catch(() => {});
        } else if (s.status === 'read') {
          await query(`UPDATE whatsapp_messages SET status='read', read_at=COALESCE(read_at,$1), delivered_at=COALESCE(delivered_at,$1) WHERE wa_message_id=$2`, [at, s.id]).catch(() => {});
        } else if (s.status === 'failed') {
          const err = s.errors?.[0];
          const detail = err ? `${err.code ? `[${err.code}] ` : ''}${err.title || err.message || 'Unknown error'}${err.error_data?.details ? ` — ${err.error_data.details}` : ''}` : null;
          await query(`UPDATE whatsapp_messages SET status='failed', error_detail=$2 WHERE wa_message_id=$1 AND status NOT IN ('read','delivered')`, [s.id, detail]).catch(() => {});
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

      // A receiving number identifies the workspace before looking up any sender.
      const receivingTenantId=numberOwner?.tenant_id || await findTenantBySharedNumber(receivingNumberId);
      if(!receivingTenantId)continue;
      // WhatsApp sends the full international number without "+": match every stored format of
      // it (E.164, national, 0-prefixed), skip merged duplicates, always the oldest lead — so one
      // contact never splits into two conversation threads.
      let digits = [String(fromPhone).replace(/\D/g, '')];
      try { digits = phoneDigitVariants(normalizePhone(`+${fromPhone}`)); } catch {}
      const leadResult=await query(
        `SELECT id,tenant_id,name,assigned_to,ai_paused,opted_out,source,source_detail,phone FROM leads
         WHERE tenant_id=$1 AND merged_into_id IS NULL AND phone_digits = ANY($2::text[]) ORDER BY created_at, id LIMIT 1`,
        [receivingTenantId, digits]
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

      // Claim provider retries and store the inbound message in one atomic statement.
      const savedInbound=await query(
        `WITH claimed AS (
          INSERT INTO inbound_reply_claims(tenant_id,message_id) VALUES($1,$7)
          ON CONFLICT DO NOTHING RETURNING message_id
        ) INSERT INTO whatsapp_messages(tenant_id,lead_id,direction,message,message_type,media_url,wa_message_id,status,sent_at)
          SELECT $1,$2,'inbound',$3,$4,$5,$6,'delivered',NOW() FROM claimed RETURNING id`,
        [lead.tenant_id,lead.id,messageText,messageType,mediaUrl,waMessageId,`received:${waMessageId}`]
      );
      if(!savedInbound.rows.length)continue;

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
        // START / SUBSCRIBE is an explicit opt-in (also re-subscribes after STOP).
        if (isOptInMessage(messageText)) {
          await recordOptIn({ tenantId: lead.tenant_id, leadId: lead.id, source: 'whatsapp_keyword', resubscribe: true }).catch(() => {});
          lead.opted_out = false;
          await query(`INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title) VALUES ($1, $2, 'opted_in', 'Lead opted in to WhatsApp messages')`,
            [lead.tenant_id, lead.id]).catch(() => {});
        }
      }

      // Get tenant settings to check if AI auto-reply is enabled
      const tenantResult = await query('SELECT settings, name FROM tenants WHERE id = $1', [lead.tenant_id]);
      const tenant = tenantResult.rows[0];
      const aiEnabled = tenant?.settings?.ai_qualification_enabled;

      // Away message: outside business hours, at most once per 12h per lead. If sent, the AI skips this turn.
      let awaySent = await require('../services/inboundReplies').replyToInbound({lead,text:messageText,messageId:waMessageId,settings:tenant?.settings || {}});
      await query("INSERT INTO integration_health(tenant_id,provider,last_lead_received_at,token_valid) VALUES($1,'whatsapp',now(),true) ON CONFLICT(tenant_id,provider) DO UPDATE SET last_lead_received_at=now(),token_valid=true",[lead.tenant_id]);
      if (!awaySent && !lead.ai_paused && tenant?.settings?.whatsapp_away_enabled && tenant.settings.whatsapp_away_message && !lead.opted_out
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
          // Recent messages, newest first, without the inbound just saved.
          const historyResult = await query(
            `SELECT id, direction, message, is_ai_generated, is_automated FROM whatsapp_messages WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 20`,
            [lead.id]
          );
          const history = historyResult.rows.filter(m => m.id !== savedInbound.rows[0].id);

          // Another business's bot answering our bot: pause instead of looping.
          if (shouldPauseAi({ text: messageText, history })) {
            await pauseAiForAutoReplies({ lead, text: messageText });
            continue;
          }

          const aiResponse = await qualifyLead(
            lead.name,
            history.slice(0, 10).reverse().map(({ direction, message }) => ({ direction, message })),
            messageText,
            {
              business_name: tenant.name, description: tenant.settings?.business_description,
              knowledge: tenant.settings?.ai_knowledge,
              lead_source: [lead.source, lead.source_detail].filter(Boolean).join(' — ') || null,
            }
          );

          // Never send the same reply (e.g. a booking confirmation) twice in a row.
          const lastAiReply = history.find(m => m.direction === 'outbound' && m.is_ai_generated)?.message;
          if (isRepeatOf(aiResponse.reply, lastAiReply)) {
            await query(`INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description) VALUES ($1, $2, 'ai_reply_suppressed', 'AI reply not sent — same as its previous message', $3)`,
              [lead.tenant_id, lead.id, aiResponse.reply]).catch(() => {});
            continue;
          }

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
          // The same booking again (±15 min) is not re-booked or re-announced.
          const alreadyBooked = bookingIsPlausible && (await query(
            `SELECT 1 FROM lead_followups WHERE tenant_id = $1 AND lead_id = $2 AND is_completed = false AND dismissed_at IS NULL
               AND lower(followup_type) IN ('demo','visit') AND abs(extract(epoch FROM (next_followup_at - $3::timestamptz))) <= 900`,
            [lead.tenant_id, lead.id, bookingAt.toISOString()]
          )).rows.length > 0;
          if (bookingIsPlausible && !alreadyBooked) {
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

      // Notify about the new message — the assigned rep if there is one, otherwise
      // every admin, so an unassigned lead's reply never goes unnoticed by everyone.
      // Goes through createNotification() so it respects each person's own
      // Notification Settings ("New WhatsApp messages" toggle), instead of the
      // unconditional raw insert this used to be.
      const msgNotifyTitle = `New message from ${lead.name}`;
      const msgNotifyBody = messageText.substring(0, 100);
      if (lead.assigned_to) {
        await createNotification(lead.tenant_id, lead.assigned_to, msgNotifyTitle, msgNotifyBody, 'whatsapp', 'lead', lead.id).catch(() => {});
      } else {
        const admins = await query(
          `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`,
          [lead.tenant_id]
        );
        for (const admin of admins.rows) {
          await createNotification(lead.tenant_id, admin.id, msgNotifyTitle, msgNotifyBody, 'whatsapp', 'lead', lead.id).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
  }
};

// Auto-reply guard tripped: pause the AI for this lead, say why on the timeline and tell
// the assigned rep (or the admins) so a person can take over.
async function pauseAiForAutoReplies({ lead, text }) {
  await query('UPDATE leads SET ai_paused = true WHERE id = $1 AND tenant_id = $2', [lead.id, lead.tenant_id]);
  const why = `The last ${MAX_AUTOMATED_AI_TURNS} messages from ${lead.name} looked automated (an auto-reply or repeated text), so AI replies were paused to avoid a bot-to-bot loop.`;
  await query(`INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, metadata) VALUES ($1, $2, 'ai_paused', 'AI auto-reply paused', $3, $4)`,
    [lead.tenant_id, lead.id, why, JSON.stringify({ reason: 'automated_replies', last_message: String(text).slice(0, 500) })]).catch(() => {});
  const title = `AI paused — automated replies from ${lead.name}`;
  const recipients = lead.assigned_to ? [lead.assigned_to]
    : (await query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true`, [lead.tenant_id])).rows.map(r => r.id);
  for (const userId of recipients) await createNotification(lead.tenant_id, userId, title, why, 'ai_handoff', 'lead', lead.id).catch(() => {});
}

module.exports = {
  getInbox, getConversation, sendMessage, setConversationAi, startChat, sendAttachment, handleWebhook,
  updateChatLabels, deleteConversations, markConversationsRead,
};
