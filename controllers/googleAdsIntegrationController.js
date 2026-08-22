const { query } = require('../config/db');
const { nextLeadNumber } = require('../utils/leadNumber');
const { parseUserColumnData } = require('../utils/googleLeadFields');
const { encryptSecret, decryptSecret, generateWebhookKey, timingSafeEqualStrings, maskKey } = require('../utils/cryptoSecrets');
const { checkNewLeadTriggers } = require('../utils/automationTriggers');
const { applyAssignmentRules, pickRoundRobinMember } = require('../utils/leadAssignment');
const { notifyNewLead } = require('../utils/leadNotifyEmail');
const { notifyNewLeadToAdmins, createNotification } = require('./notificationController');

const webhookUrlFor = (integrationId) =>
  `${process.env.API_BASE_URL || 'https://api.curvelead.com'}/api/integrations/google-ads/leads/${integrationId}`;

const toPublicRow = (row) => ({
  id: row.id,
  name: row.name,
  is_active: row.is_active,
  default_group: row.default_group || '',
  default_stage: row.default_stage || '',
  assigned_user_id: row.assigned_user_id || '',
  assigned_team_id: row.assigned_team_id || '',
  product: row.product || '',
  test_lead_behavior: row.test_lead_behavior,
  created_at: row.created_at,
  updated_at: row.updated_at,
  last_test_received_at: row.last_test_received_at,
  last_live_lead_received_at: row.last_live_lead_received_at,
  webhook_url: webhookUrlFor(row.id),
  webhook_key_masked: maskKey(safeDecrypt(row.webhook_key_encrypted)),
});

// Defensive — an integration with a corrupted/foreign ciphertext (e.g. JWT_SECRET
// rotated) should still render in the UI as "key unavailable", not 500 the page.
const safeDecrypt = (encrypted) => {
  try { return decryptSecret(encrypted); } catch { return null; }
};

// ── Admin CRUD — GET/POST /api/integrations/google-ads ─────────────────────

const listIntegrations = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM google_ads_integrations WHERE tenant_id = $1 ORDER BY created_at ASC',
      [req.tenantId]
    );
    res.json({ integrations: result.rows.map(toPublicRow) });
  } catch (e) { console.error('listIntegrations:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const getIntegration = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM google_ads_integrations WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json(toPublicRow(result.rows[0]));
  } catch (e) { console.error('getIntegration:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const createIntegration = async (req, res) => {
  try {
    const { name, default_group, default_stage, assigned_user_id, assigned_team_id, product, test_lead_behavior } = req.body;
    const plainKey = generateWebhookKey();
    const result = await query(
      `INSERT INTO google_ads_integrations
        (tenant_id, name, webhook_key_encrypted, default_group, default_stage, assigned_user_id, assigned_team_id, product, test_lead_behavior, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.tenantId, name || 'Google Ads Lead Form', encryptSecret(plainKey),
        default_group || null, default_stage || null,
        assigned_user_id || null, assigned_team_id || null,
        product || null, test_lead_behavior === 'log_only' ? 'log_only' : 'create_labeled_lead',
        req.user.id,
      ]
    );
    res.status(201).json({ ...toPublicRow(result.rows[0]), webhook_key: plainKey });
  } catch (e) { console.error('createIntegration:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const updateIntegration = async (req, res) => {
  try {
    const { name, is_active, default_group, default_stage, assigned_user_id, assigned_team_id, product, test_lead_behavior } = req.body;
    const current = await query('SELECT * FROM google_ads_integrations WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!current.rows.length) return res.status(404).json({ error: 'Not found.' });
    const row = current.rows[0];

    const result = await query(
      `UPDATE google_ads_integrations SET
        name = $1, is_active = $2, default_group = $3, default_stage = $4,
        assigned_user_id = $5, assigned_team_id = $6, product = $7, test_lead_behavior = $8,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 AND tenant_id = $10 RETURNING *`,
      [
        name !== undefined ? name : row.name,
        is_active !== undefined ? !!is_active : row.is_active,
        default_group !== undefined ? (default_group || null) : row.default_group,
        default_stage !== undefined ? (default_stage || null) : row.default_stage,
        // assigned_user_id / assigned_team_id are mutually exclusive — setting one clears the other
        assigned_user_id ? assigned_user_id : (assigned_team_id ? null : row.assigned_user_id),
        assigned_team_id ? assigned_team_id : (assigned_user_id ? null : row.assigned_team_id),
        product !== undefined ? (product || null) : row.product,
        test_lead_behavior !== undefined ? (test_lead_behavior === 'log_only' ? 'log_only' : 'create_labeled_lead') : row.test_lead_behavior,
        req.params.id, req.tenantId,
      ]
    );
    res.json(toPublicRow(result.rows[0]));
  } catch (e) { console.error('updateIntegration:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const regenerateKey = async (req, res) => {
  try {
    const plainKey = generateWebhookKey();
    const result = await query(
      `UPDATE google_ads_integrations SET webhook_key_encrypted = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [encryptSecret(plainKey), req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ ...toPublicRow(result.rows[0]), webhook_key: plainKey });
  } catch (e) { console.error('regenerateKey:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const revealKey = async (req, res) => {
  try {
    const result = await query('SELECT webhook_key_encrypted FROM google_ads_integrations WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    const plainKey = safeDecrypt(result.rows[0].webhook_key_encrypted);
    if (!plainKey) return res.status(500).json({ error: 'Key unavailable — try regenerating it.' });
    res.json({ webhook_key: plainKey });
  } catch (e) { console.error('revealKey:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const deleteTestLeads = async (req, res) => {
  try {
    const owned = await query('SELECT id FROM google_ads_integrations WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Not found.' });
    const result = await query(
      `DELETE FROM leads WHERE tenant_id = $1 AND google_ads_integration_id = $2 AND is_test_lead = true RETURNING id`,
      [req.tenantId, req.params.id]
    );
    res.json({ message: `Deleted ${result.rows.length} test lead(s).`, deleted: result.rows.length });
  } catch (e) { console.error('deleteTestLeads:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

const deleteIntegration = async (req, res) => {
  try {
    await query('DELETE FROM google_ads_integrations WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    res.json({ message: 'Integration deleted.' });
  } catch (e) { console.error('deleteIntegration:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

// ── Public webhook — POST /api/integrations/google-ads/leads/:integrationId ─

// Resolves who a live lead should be assigned to from the integration's own
// config, before falling back to the tenant's generic assignment_rules engine.
// Mirrors the round-robin logic in utils/leadAssignment.js but scoped to this
// integration's own last_assigned_user_id cursor rather than a rule's.
const resolveAssignee = async (tenantId, integration) => {
  if (integration.assigned_user_id) {
    const check = await query(
      'SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND is_active = true',
      [integration.assigned_user_id, tenantId]
    );
    if (check.rows.length) return integration.assigned_user_id;
    return null;
  }
  if (integration.assigned_team_id) {
    const members = await query(
      `SELECT id FROM users WHERE tenant_id = $1 AND team_id = $2 AND is_active = true ORDER BY created_at ASC`,
      [tenantId, integration.assigned_team_id]
    );
    const picked = pickRoundRobinMember(members.rows, integration.last_assigned_user_id);
    if (picked) {
      await query('UPDATE google_ads_integrations SET last_assigned_user_id = $1 WHERE id = $2', [picked.id, integration.id]);
      return picked.id;
    }
  }
  return null;
};

const resolveDefaultStage = async (tenantId, integration) => {
  if (integration.default_stage) return integration.default_stage;
  const first = await query(
    `SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_active = true ORDER BY pos ASC LIMIT 1`,
    [tenantId]
  );
  return first.rows[0]?.name || 'new';
};

const receiveGoogleAdsLead = async (req, res) => {
  const { integrationId } = req.params;

  let integration;
  try {
    const result = await query('SELECT * FROM google_ads_integrations WHERE id = $1', [integrationId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    integration = result.rows[0];
  } catch (e) {
    console.error('Google Ads webhook: integration lookup failed:', e.message);
    return res.status(500).json({ error: 'Failed.' });
  }

  const { google_key } = req.body || {};
  if (!google_key) return res.status(400).json({ error: 'Invalid request.' });

  const storedKey = safeDecrypt(integration.webhook_key_encrypted);
  if (!storedKey || !timingSafeEqualStrings(google_key, storedKey)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (!integration.is_active) return res.status(403).json({ error: 'Integration is inactive.' });

  // Validated — respond immediately, process the rest asynchronously.
  res.sendStatus(200);

  try {
    const tenantId = integration.tenant_id;
    const {
      lead_id, form_id, campaign_id, adgroup_id, creative_id, asset_group_id,
      is_test, gcl_id, lead_submit_time, user_column_data = [],
    } = req.body;
    // Google's own `lead_stage` (form submission status) is accepted without
    // erroring but intentionally not applied to CurveLead's `stage` column —
    // that's a tenant-customized pipeline (lead_stages.name), not something
    // Google's payload values would ever match.

    const { standard, custom } = parseUserColumnData(user_column_data);
    const name = standard.full_name
      || [standard.first_name, standard.last_name].filter(Boolean).join(' ').trim()
      || 'Unknown';
    const phone = standard.phone_number || '';
    const email = standard.email || '';

    if (!phone) {
      console.warn(`Google Ads webhook: no phone in lead for integration ${integrationId}, skipping`);
      return;
    }

    if (is_test === true) {
      await query('UPDATE google_ads_integrations SET last_test_received_at = CURRENT_TIMESTAMP WHERE id = $1', [integrationId]);
      if (integration.test_lead_behavior === 'log_only') {
        console.log(`Google Ads webhook: test event logged for integration ${integrationId}`);
        return;
      }
      // fall through to create a clearly-labelled test lead below
    }

    const stage = await resolveDefaultStage(tenantId, integration);
    const assignedTo = is_test ? null : await resolveAssignee(tenantId, integration);
    const tags = integration.default_group ? [integration.default_group] : null;

    const leadNumber = await nextLeadNumber(tenantId);
    const inserted = await query(
      `INSERT INTO leads (
         tenant_id, lead_number, name, phone, email, source, source_detail, stage, assigned_to,
         tags, product, is_test_lead,
         google_lead_id, gclid, google_campaign_id, google_form_id, google_adgroup_id,
         google_creative_id, google_asset_group_id, lead_submit_time, google_custom_answers,
         google_ads_integration_id
       ) VALUES (
         $1,$2,$3,$4,$5,'google_ads',$6,$7,$8,
         $9,$10,$11,
         $12,$13,$14,$15,$16,
         $17,$18,$19,$20,
         $21
       )
       ON CONFLICT (tenant_id, google_lead_id) WHERE google_lead_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        tenantId, leadNumber, name, phone, email || null,
        `Google Ads — form ${form_id || 'unknown'}`, stage, assignedTo,
        tags, integration.product || null, !!is_test,
        lead_id || null, gcl_id || null, campaign_id ? String(campaign_id) : null, form_id ? String(form_id) : null,
        adgroup_id ? String(adgroup_id) : null, creative_id ? String(creative_id) : null,
        asset_group_id ? String(asset_group_id) : null,
        lead_submit_time ? new Date(lead_submit_time) : null,
        JSON.stringify(custom),
        integration.id,
      ]
    );

    const lead = inserted.rows[0];
    if (!lead) {
      // No row returned = ON CONFLICT hit (Google retried a lead_id we already have).
      console.log(`Google Ads webhook: duplicate lead_id for integration ${integrationId}, no-op`);
      return;
    }

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, metadata, created_by)
       VALUES ($1,$2,'created',$3,$4,$5,NULL)`,
      [
        tenantId, lead.id,
        is_test ? 'Test lead received from Google Ads Lead Form' : 'Lead received from Google Ads Lead Form',
        `Form ${form_id || 'unknown'}${campaign_id ? `, campaign ${campaign_id}` : ''}`,
        JSON.stringify({ gclid: gcl_id || null, campaign_id: campaign_id || null, form_id: form_id || null, is_test: !!is_test }),
      ]
    );

    if (is_test) {
      console.log(`✅ Google Ads test lead captured for integration ${integrationId}`);
      return;
    }

    await query('UPDATE google_ads_integrations SET last_live_lead_received_at = CURRENT_TIMESTAMP WHERE id = $1', [integrationId]);

    if (assignedTo) {
      createNotification(
        tenantId, assignedTo, 'New lead assigned to you',
        `${lead.name} — respond within 5 minutes to hit SLA`,
        'assignment', 'lead', lead.id
      ).catch(() => {});
    }
    applyAssignmentRules({ tenantId, lead })
      .then(() => notifyNewLead({ tenantId, lead }))
      .catch(() => {});
    checkNewLeadTriggers({ tenantId, lead }).catch(() => {});
    notifyNewLeadToAdmins(tenantId, lead).catch(() => {});

    console.log(`✅ Google Ads lead captured for integration ${integrationId}`);
  } catch (e) {
    console.error(`Google Ads webhook error for integration ${integrationId}:`, e.message);
  }
};

module.exports = {
  listIntegrations, getIntegration, createIntegration, updateIntegration,
  regenerateKey, revealKey, deleteTestLeads, deleteIntegration,
  receiveGoogleAdsLead,
};
