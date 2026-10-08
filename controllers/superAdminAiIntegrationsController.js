const axios = require('axios');
const { query } = require('../config/db');
const { encryptSecret, decryptSecret, maskKey } = require('../utils/cryptoSecrets');
const { clearGroqKeyCache } = require('../utils/platformAiKey');

// Providers the backend can actually use. Each entry is wired into a service (see utils/platformAiKey.js),
// so adding a provider here without wiring it would be a fake integration.
const SUPPORTED_PROVIDERS = [
  { provider: 'groq', label: 'Groq', integration_type: 'llm', type_label: 'LLM / AI Reply', credential_label: 'API Key' },
];
const STATUSES = ['active', 'disabled'];

const findProvider = (provider, type) => SUPPORTED_PROVIDERS.find(p => p.provider === provider && p.integration_type === (type || p.integration_type));

const logActivity = async (req, action, status = 'Success') => {
  try {
    await query(`INSERT INTO activity_logs (tenant_id, actor_name, action, module, status) VALUES (NULL,$1,$2,'AI Agent',$3)`,
      [req.user.name || 'Super Admin', action, status]);
  } catch (e) { console.error('Activity log error:', e.message); }
};

// Never selects credential_encrypted — only the masked hint leaves the server.
const PUBLIC_COLUMNS = `id, provider, integration_type, name, credential_hint, status, last_tested_at, last_test_ok, last_test_error, created_at, updated_at`;

const tableMissing = (e) => e.code === '42P01';
const MIGRATION_HINT = 'AI integrations are not set up in the database yet. Run models/migration_super_admin_features.sql.';

// A lightweight authenticated call that proves the key is accepted by the provider.
const testGroqKey = async (apiKey) => {
  try {
    await axios.get('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 });
    return { ok: true, error: null };
  } catch (e) {
    if (e.response?.status === 401) return { ok: false, error: 'The provider rejected this API key.' };
    if (e.response) return { ok: false, error: `The provider returned an error (${e.response.status}).` };
    return { ok: false, error: 'Could not reach the provider.' };
  }
};

// GET /api/super-admin/ai/integrations
const listIntegrations = async (req, res) => {
  try {
    const result = await query(`SELECT ${PUBLIC_COLUMNS} FROM platform_ai_integrations ORDER BY created_at DESC`);
    res.json({ integrations: result.rows, supported_providers: SUPPORTED_PROVIDERS });
  } catch (e) {
    if (tableMissing(e)) return res.json({ integrations: [], supported_providers: SUPPORTED_PROVIDERS, needs_migration: true });
    console.error('List AI integrations error:', e);
    res.status(500).json({ error: 'Failed to load integrations.' });
  }
};

// POST /api/super-admin/ai/integrations   { provider, integration_type?, name?, credential, status? }
const createIntegration = async (req, res) => {
  try {
    const { provider, integration_type, name, credential, status = 'active' } = req.body;
    const def = findProvider(provider, integration_type);
    if (!def) return res.status(400).json({ error: `Unsupported provider. Supported: ${SUPPORTED_PROVIDERS.map(p => p.provider).join(', ')}.` });
    if (!credential || String(credential).trim().length < 8) return res.status(400).json({ error: 'A valid API key is required.' });
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}.` });

    const secret = String(credential).trim();
    if (status === 'active') {
      // One active key per provider: the new one replaces whichever was active.
      await query(`UPDATE platform_ai_integrations SET status = 'disabled', updated_at = NOW() WHERE provider = $1 AND integration_type = $2 AND status = 'active'`,
        [def.provider, def.integration_type]);
    }
    const result = await query(
      `INSERT INTO platform_ai_integrations (provider, integration_type, name, credential_encrypted, credential_hint, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${PUBLIC_COLUMNS}`,
      [def.provider, def.integration_type, name?.trim() || def.label, encryptSecret(secret), maskKey(secret), status, req.user.id]
    );
    clearGroqKeyCache();
    await logActivity(req, `AI integration added: ${def.label}`);
    res.status(201).json({ integration: result.rows[0] });
  } catch (e) {
    if (tableMissing(e)) return res.status(503).json({ error: MIGRATION_HINT });
    console.error('Create AI integration error:', e);
    res.status(500).json({ error: 'Failed to add the integration.' });
  }
};

// PUT /api/super-admin/ai/integrations/:id   { name?, credential?, status? }
const updateIntegration = async (req, res) => {
  try {
    const { name, credential, status } = req.body;
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}.` });
    if (credential !== undefined && credential !== '' && String(credential).trim().length < 8) return res.status(400).json({ error: 'A valid API key is required.' });

    const existing = await query('SELECT provider, integration_type FROM platform_ai_integrations WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Integration not found.' });
    const { provider, integration_type } = existing.rows[0];

    if (status === 'active') {
      await query(`UPDATE platform_ai_integrations SET status = 'disabled', updated_at = NOW() WHERE provider = $1 AND integration_type = $2 AND status = 'active' AND id <> $3`,
        [provider, integration_type, req.params.id]);
    }
    const newSecret = credential ? String(credential).trim() : null;
    const result = await query(
      `UPDATE platform_ai_integrations SET
         name = COALESCE($1, name),
         credential_encrypted = COALESCE($2, credential_encrypted),
         credential_hint = COALESCE($3, credential_hint),
         status = COALESCE($4, status),
         last_tested_at = CASE WHEN $2 IS NOT NULL THEN NULL ELSE last_tested_at END,
         last_test_ok = CASE WHEN $2 IS NOT NULL THEN NULL ELSE last_test_ok END,
         last_test_error = CASE WHEN $2 IS NOT NULL THEN NULL ELSE last_test_error END,
         updated_at = NOW()
       WHERE id = $5 RETURNING ${PUBLIC_COLUMNS}`,
      [name?.trim() || null, newSecret ? encryptSecret(newSecret) : null, newSecret ? maskKey(newSecret) : null, status || null, req.params.id]
    );
    clearGroqKeyCache();
    await logActivity(req, `AI integration ${status === 'disabled' ? 'disabled' : status === 'active' ? 'enabled' : 'updated'}: ${provider}`);
    res.json({ integration: result.rows[0] });
  } catch (e) {
    console.error('Update AI integration error:', e);
    res.status(500).json({ error: 'Failed to update the integration.' });
  }
};

// POST /api/super-admin/ai/integrations/:id/test
const testIntegration = async (req, res) => {
  try {
    const found = await query('SELECT provider, credential_encrypted FROM platform_ai_integrations WHERE id = $1', [req.params.id]);
    if (!found.rows.length) return res.status(404).json({ error: 'Integration not found.' });

    const outcome = await testGroqKey(decryptSecret(found.rows[0].credential_encrypted));
    const result = await query(
      `UPDATE platform_ai_integrations SET last_tested_at = NOW(), last_test_ok = $1, last_test_error = $2 WHERE id = $3 RETURNING ${PUBLIC_COLUMNS}`,
      [outcome.ok, outcome.error, req.params.id]
    );
    await logActivity(req, `AI integration tested: ${found.rows[0].provider} (${outcome.ok ? 'ok' : 'failed'})`, outcome.ok ? 'Success' : 'Warning');
    res.json({ ok: outcome.ok, error: outcome.error, integration: result.rows[0] });
  } catch (e) {
    console.error('Test AI integration error:', e);
    res.status(500).json({ error: 'Failed to test the integration.' });
  }
};

// DELETE /api/super-admin/ai/integrations/:id
const deleteIntegration = async (req, res) => {
  try {
    const result = await query('DELETE FROM platform_ai_integrations WHERE id = $1 RETURNING provider', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Integration not found.' });
    clearGroqKeyCache();
    await logActivity(req, `AI integration deleted: ${result.rows[0].provider}`, 'Warning');
    res.json({ message: 'Integration deleted.' });
  } catch (e) {
    console.error('Delete AI integration error:', e);
    res.status(500).json({ error: 'Failed to delete the integration.' });
  }
};

module.exports = { listIntegrations, createIntegration, updateIntegration, testIntegration, deleteIntegration, SUPPORTED_PROVIDERS };
