const { query } = require('../config/db');
const { sendTextMessage, sendTemplate } = require('../services/whatsappService');
const { qualifyLead } = require('../services/groqService');
const { recordFirstResponse } = require('../utils/leadResponse');

// GET /api/whatsapp/inbox - Shared team inbox (all conversations)
const getInbox = async (req, res) => {
  try {
    const { search, unread_only } = req.query;
    let where = 'WHERE wm.tenant_id = $1';
    const params = [req.tenantId];

    // Group by lead, get latest message per lead
    const result = await query(
      `SELECT DISTINCT ON (wm.lead_id)
              wm.lead_id, wm.message, wm.direction, wm.sent_at, wm.status,
              l.name as lead_name, l.phone as lead_phone, l.lead_score, l.stage,
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

// GET /api/whatsapp/conversation/:leadId - Get message thread for a lead
const getConversation = async (req, res) => {
  try {
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

// POST /api/whatsapp/send - Send a message to a lead
const sendMessage = async (req, res) => {
  try {
    const { lead_id, message, template_name } = req.body;
    if (!lead_id || (!message && !template_name)) {
      return res.status(400).json({ error: 'lead_id and message required.' });
    }

    const leadResult = await query(
      'SELECT phone, name FROM leads WHERE id = $1 AND tenant_id = $2',
      [lead_id, req.tenantId]
    );
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const lead = leadResult.rows[0];
    const result = template_name
      ? await sendTemplate(lead.phone, template_name)
      : await sendTextMessage(lead.phone, message);

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

    // Update lead's last contacted
    await query('UPDATE leads SET last_contacted_at = NOW() WHERE id = $1', [lead_id]);
    recordFirstResponse(req.tenantId, lead_id, { by: req.user.id, type: 'whatsapp' }).catch(() => {});

    res.status(201).json({ message: saved.rows[0], delivery: result });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
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
    const messages = change?.value?.messages;
    if (!messages) return;

    for (const msg of messages) {
      const fromPhone = msg.from; // e.g. "919876543210"
      const messageText = msg.text?.body || `[${msg.type}]`;
      const waMessageId = msg.id;

      // Find lead by phone (across all tenants matching this WhatsApp number)
      const leadResult = await query(
        'SELECT id, tenant_id, name, assigned_to FROM leads WHERE phone = $1 OR phone = $2 LIMIT 1',
        [fromPhone, fromPhone.replace(/^91/, '')]
      );

      if (leadResult.rows.length === 0) {
        console.log(`Unknown WhatsApp number: ${fromPhone}`);
        continue;
      }

      const lead = leadResult.rows[0];

      // Save inbound message
      await query(
        `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, wa_message_id, status, sent_at)
         VALUES ($1, $2, 'inbound', $3, $4, 'delivered', NOW())`,
        [lead.tenant_id, lead.id, messageText, waMessageId]
      );

      // Get tenant settings to check if AI auto-reply is enabled
      const tenantResult = await query('SELECT settings, name FROM tenants WHERE id = $1', [lead.tenant_id]);
      const tenant = tenantResult.rows[0];
      const aiEnabled = tenant?.settings?.ai_qualification_enabled;

      if (aiEnabled) {
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
            { business_name: tenant.name, description: tenant.settings?.business_description }
          );

          // Send AI reply
          const sendResult = await sendTextMessage(fromPhone, aiResponse.reply);
          await query(
            `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, wa_message_id, status, is_ai_generated)
             VALUES ($1, $2, 'outbound', $3, 'text', $4, $5, true)`,
            [lead.tenant_id, lead.id, aiResponse.reply, sendResult.wa_message_id, sendResult.success ? 'sent' : 'failed']
          );

          // Update lead based on AI intent
          if (aiResponse.intent === 'not_interested') {
            await query(`UPDATE leads SET stage = 'lost', lost_at = NOW(), lost_reason = 'Not interested' WHERE id = $1`, [lead.id]);
          } else if (aiResponse.intent === 'ready_to_buy') {
            await query(`UPDATE leads SET lead_score = 'hot', stage = 'qualified' WHERE id = $1`, [lead.id]);
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

module.exports = { getInbox, getConversation, sendMessage, handleWebhook };
