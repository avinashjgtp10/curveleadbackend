const { query } = require('../config/db');
const { sendTemplate, listMessageTemplates, createMessageTemplate } = require('../services/whatsappService');
const { resolveWhatsAppCredentials } = require('../utils/whatsappCredentials');

const LEAD_FIELD_ALLOWLIST = ['name', 'phone', 'email', 'location', 'stage', 'assigned_to_name'];
const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

const getWhatsappCreds = async (tenantId) => {
  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const settings = result.rows[0]?.settings || {};
  return { wabaId: settings.whatsapp_business_account_id, accessToken: settings.whatsapp_access_token };
};

// GET /api/whatsapp/broadcast/templates — this tenant's WABA templates (any status;
// the broadcast picker shows APPROVED as sendable, others as pending/rejected)
const getBroadcastTemplates = async (req, res) => {
  try {
    const { wabaId, accessToken } = await getWhatsappCreds(req.tenantId);
    if (!wabaId || !accessToken) {
      return res.status(400).json({ error: 'Connect WhatsApp and add your WhatsApp Business Account ID in Integrations first.' });
    }

    const listResult = await listMessageTemplates(wabaId, accessToken);
    if (!listResult.success) return res.status(502).json({ error: listResult.error });

    res.json({ templates: listResult.templates });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/whatsapp/broadcast/templates — submit a new BODY-only template for Meta's approval
const createBroadcastTemplate = async (req, res) => {
  try {
    const { name, category, language, body_text, examples } = req.body;

    if (!name || !/^[a-z0-9_]+$/.test(name)) {
      return res.status(400).json({ error: 'Template name must be lowercase letters, numbers, and underscores only.' });
    }
    if (!TEMPLATE_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Category must be one of: ${TEMPLATE_CATEGORIES.join(', ')}.` });
    }
    if (!body_text?.trim()) return res.status(400).json({ error: 'Body text is required.' });

    const varCount = new Set([...body_text.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1])).size;
    const exampleList = Array.isArray(examples) ? examples.filter(Boolean) : [];
    if (varCount > 0 && exampleList.length !== varCount) {
      return res.status(400).json({ error: `Provide an example value for each of the ${varCount} variable(s) in the body.` });
    }

    const { wabaId, accessToken } = await getWhatsappCreds(req.tenantId);
    if (!wabaId || !accessToken) {
      return res.status(400).json({ error: 'Connect WhatsApp and add your WhatsApp Business Account ID in Integrations first.' });
    }

    const createResult = await createMessageTemplate(wabaId, accessToken, {
      name, category, language: language || 'en_US', bodyText: body_text, examples: exampleList,
    });
    if (!createResult.success) return res.status(502).json({ error: createResult.error });

    res.status(201).json({ id: createResult.id, status: createResult.status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/whatsapp/broadcast/send — send a Meta-approved template to many leads at once
const sendBroadcast = async (req, res) => {
  try {
    const { lead_ids, template_name, language_code, body_text, variable_mapping } = req.body;

    if (!Array.isArray(lead_ids) || !lead_ids.length) return res.status(400).json({ error: 'lead_ids required.' });
    if (lead_ids.length > 250) return res.status(400).json({ error: 'Max 250 leads per broadcast.' });
    if (!template_name) return res.status(400).json({ error: 'template_name required.' });

    const mapping = Array.isArray(variable_mapping) ? [...variable_mapping] : [];
    for (const m of mapping) {
      if (!Number.isInteger(m.position) || m.position < 1) return res.status(400).json({ error: 'Invalid variable_mapping position.' });
      if (!['field', 'fixed'].includes(m.source)) return res.status(400).json({ error: 'Invalid variable_mapping source.' });
      if (m.source === 'field' && !LEAD_FIELD_ALLOWLIST.includes(m.value)) return res.status(400).json({ error: `Invalid field: ${m.value}` });
    }
    mapping.sort((a, b) => a.position - b.position);
    const sequential = mapping.every((m, i) => m.position === i + 1);
    if (mapping.length && !sequential) return res.status(400).json({ error: 'variable_mapping positions must be sequential starting at 1.' });

    const needsAssignedName = mapping.some(m => m.source === 'field' && m.value === 'assigned_to_name');
    const leadsResult = await query(
      `SELECT l.id, l.name, l.phone, l.email, l.location, l.stage, l.assigned_to${needsAssignedName ? ', u.name as assigned_to_name' : ''}
       FROM leads l
       ${needsAssignedName ? 'LEFT JOIN users u ON l.assigned_to = u.id' : ''}
       WHERE l.tenant_id = $1 AND l.id = ANY($2::uuid[])`,
      [req.tenantId, lead_ids]
    );

    const credCache = new Map();
    const results = [];
    let sent = 0, failed = 0;

    for (const lead of leadsResult.rows) {
      try {
        if (!lead.phone) throw new Error('Lead has no phone number.');

        const parameters = mapping.map(m => ({
          type: 'text',
          text: String(m.source === 'fixed' ? (m.value || '') : (lead[m.value] || '')),
        }));

        const credKey = lead.assigned_to || 'tenant';
        if (!credCache.has(credKey)) {
          credCache.set(credKey, await resolveWhatsAppCredentials(req.tenantId, lead.assigned_to));
        }
        const credentials = credCache.get(credKey);

        const sendResult = await sendTemplate(lead.phone, template_name, language_code || 'en', parameters, credentials);

        let renderedMessage = body_text || `[Template: ${template_name}]`;
        parameters.forEach((p, i) => {
          renderedMessage = renderedMessage.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), p.text);
        });

        await query(
          `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, template_name, wa_message_id, status, sent_by)
           VALUES ($1,$2,'outbound',$3,'template',$4,$5,$6,$7)`,
          [req.tenantId, lead.id, renderedMessage, template_name, sendResult.wa_message_id || null, sendResult.success ? 'sent' : 'failed', req.user.id]
        );

        if (sendResult.success) {
          await query('UPDATE leads SET last_contacted_at = NOW() WHERE id = $1', [lead.id]);
          sent++;
          results.push({ lead_id: lead.id, success: true });
        } else {
          failed++;
          results.push({ lead_id: lead.id, success: false, error: sendResult.error });
        }
      } catch (e) {
        failed++;
        results.push({ lead_id: lead.id, success: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ sent, failed, results });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getBroadcastTemplates, createBroadcastTemplate, sendBroadcast };
