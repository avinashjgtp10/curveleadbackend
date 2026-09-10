const path = require('path');
const { query } = require('../config/db');
const { sendTemplate, listMessageTemplates, createMessageTemplate, uploadTemplateMedia } = require('../services/whatsappService');
const { resolveWhatsAppCredentials } = require('../utils/whatsappCredentials');
const { uploadToS3 } = require('../config/s3');

const LEAD_FIELD_ALLOWLIST = ['name', 'phone', 'email', 'location', 'stage', 'assigned_to_name'];
const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
const MEDIA_TYPES = ['IMAGE', 'VIDEO', 'DOCUMENT'];

const getWhatsappCreds = async (tenantId) => {
  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  const settings = result.rows[0]?.settings || {};
  return {
    wabaId: settings.whatsapp_business_account_id,
    accessToken: settings.whatsapp_access_token,
    appId: settings.whatsapp_app_id,
  };
};

// GET /api/whatsapp/broadcast/templates — this tenant's WABA templates (any status;
// the broadcast picker shows APPROVED as sendable, others as pending/rejected).
// Media (image/video/document) info is attached from our own records, since
// Meta never returns a template's media back to us once created.
const getBroadcastTemplates = async (req, res) => {
  try {
    const { wabaId, accessToken } = await getWhatsappCreds(req.tenantId);
    if (!wabaId || !accessToken) {
      return res.status(400).json({ error: 'Connect WhatsApp and add your WhatsApp Business Account ID in Integrations first.' });
    }

    const listResult = await listMessageTemplates(wabaId, accessToken);
    if (!listResult.success) return res.status(502).json({ error: listResult.error });

    const mediaResult = await query(
      'SELECT template_name, language, media_type, media_url FROM whatsapp_template_media WHERE tenant_id = $1',
      [req.tenantId]
    );
    const mediaByKey = new Map(mediaResult.rows.map(r => [`${r.template_name}::${r.language}`, r]));
    const templates = listResult.templates.map(t => {
      const media = mediaByKey.get(`${t.name}::${t.language}`);
      return media ? { ...t, media_type: media.media_type, media_url: media.media_url } : t;
    });

    res.json({ templates });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/whatsapp/broadcast/templates/media — upload an image/video/document
// for a template's header: puts it on S3 (used later when sending) and gets a
// Meta "header_handle" (used now, for the template creation example).
const uploadBroadcastMedia = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const mediaType = (req.body.media_type || '').toUpperCase();
    if (!MEDIA_TYPES.includes(mediaType)) return res.status(400).json({ error: `media_type must be one of: ${MEDIA_TYPES.join(', ')}.` });

    const { appId, accessToken } = await getWhatsappCreds(req.tenantId);
    if (!appId || !accessToken) {
      return res.status(400).json({ error: 'Add your Meta App ID in Integrations first.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const key = `whatsapp-templates/${req.tenantId}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const url = await uploadToS3(req.file.buffer, key, req.file.mimetype);

    const handleResult = await uploadTemplateMedia(appId, accessToken, req.file.buffer, req.file.mimetype);
    if (!handleResult.success) return res.status(502).json({ error: handleResult.error });

    res.json({ url, handle: handleResult.handle, media_type: mediaType });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/whatsapp/broadcast/templates — submit a new BODY-only template for Meta's approval
const createBroadcastTemplate = async (req, res) => {
  try {
    const { name, category, language, body_text, examples, header_type, header_handle, header_media_url } = req.body;

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

    const hasHeader = header_type && header_handle;
    if (hasHeader && !MEDIA_TYPES.includes(header_type)) {
      return res.status(400).json({ error: `header_type must be one of: ${MEDIA_TYPES.join(', ')}.` });
    }

    const createResult = await createMessageTemplate(wabaId, accessToken, {
      name, category, language: language || 'en_US', bodyText: body_text, examples: exampleList,
      header: hasHeader ? { type: header_type, handle: header_handle } : null,
    });
    if (!createResult.success) return res.status(502).json({ error: createResult.error });

    if (hasHeader && header_media_url) {
      await query(
        `INSERT INTO whatsapp_template_media (tenant_id, template_name, language, media_type, media_url)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, template_name, language) DO UPDATE SET media_url = EXCLUDED.media_url, media_type = EXCLUDED.media_type`,
        [req.tenantId, name, language || 'en_US', header_type, header_media_url]
      );
    }

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

    const mediaRow = (await query(
      'SELECT media_type, media_url FROM whatsapp_template_media WHERE tenant_id = $1 AND template_name = $2 AND language = $3',
      [req.tenantId, template_name, language_code || 'en_US']
    )).rows[0];
    const headerMedia = mediaRow ? { type: mediaRow.media_type.toLowerCase(), link: mediaRow.media_url } : null;

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

        const sendResult = await sendTemplate(lead.phone, template_name, language_code || 'en_US', parameters, credentials, headerMedia);

        let renderedMessage = body_text || `[Template: ${template_name}]`;
        parameters.forEach((p, i) => {
          renderedMessage = renderedMessage.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), p.text);
        });

        await query(
          `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, media_url, template_name, wa_message_id, status, sent_by)
           VALUES ($1,$2,'outbound',$3,'template',$4,$5,$6,$7,$8)`,
          [req.tenantId, lead.id, renderedMessage, headerMedia?.link || null, template_name, sendResult.wa_message_id || null, sendResult.success ? 'sent' : 'failed', req.user.id]
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

module.exports = { getBroadcastTemplates, createBroadcastTemplate, sendBroadcast, uploadBroadcastMedia };
