const { query } = require('../config/db');
const queues = require('../jobs/queues');
const gads = require('../utils/googleAds');
const { decryptToken } = require('../utils/cryptoSecrets');
const { saveGoogleToken, discoverGoogleAccounts } = require('../services/googleAds/accounts');
const { isSchemaError, schemaErrorMessage } = require('../utils/schemaErrors');
const aiSearch = require('../services/googleAds/aiSearch');

// Google Ads connection (Phase 7a) and AI search ads (Phase 7b). Reading campaigns, metrics
// and the dashboard uses the shared /api/ads endpoints with ?provider=google; pause/resume
// and budgets use the shared /api/ads/campaigns|adsets endpoints.

const fail = (label) => (e, res) => {
  if (isSchemaError(e)) return res.status(503).json({ code: 'MIGRATION_PENDING', error: schemaErrorMessage(e) });
  if (e.status && e.name !== 'GoogleAdsError') return res.status(e.status).json({ error: e.message });
  if (e.name === 'GoogleAdsError') return res.status(e.status === 503 ? 503 : 400).json({ error: e.message, code: e.code || undefined });
  console.error(`[google-ads] ${label}:`, e);
  res.status(500).json({ error: `${label} failed. Please try again.` });
};

const syncAccountsOf = async (tenantId, tokenId) => {
  const { rows } = await query("SELECT id FROM ad_accounts WHERE tenant_id = $1 AND token_id = $2 AND provider = 'google' AND is_active", [tenantId, tokenId]);
  for (const a of rows) await queues.enqueue('ads:sync-account', { tenantId, adAccountId: a.id }, { jobId: `sync-${a.id}-${Date.now()}` });
  return rows.length;
};

// GET /api/ads/google/status — is the server set up, and is this workspace connected?
const status = async (req, res) => {
  try {
    const { rows } = await query("SELECT status, last_error FROM ad_oauth_tokens WHERE tenant_id = $1 AND provider = 'google' ORDER BY updated_at DESC LIMIT 1", [req.tenantId]);
    res.json({ configured: gads.configured(), connected: rows[0]?.status === 'active', token_error: rows[0]?.status === 'active' ? null : rows[0]?.last_error || null, api_version: gads.API_VERSION() });
  } catch (e) { fail('Google Ads status')(e, res); }
};

// GET /api/ads/google/connect — the Google consent URL to send the browser to.
const connectUrl = async (req, res) => {
  if (!gads.configured()) return res.status(503).json({ error: 'Google Ads isn\'t set up on this server yet (developer token and Google client are needed).' });
  res.json({ url: gads.authUrl({ tenantId: req.tenantId, userId: req.user.id }) });
};

// GET /api/ads/google/callback — public; Google redirects here after consent.
const callback = async (req, res) => {
  const back = (params) => res.redirect(`${process.env.FRONTEND_URL || 'https://curvelead.com'}/ads?tab=google&${new URLSearchParams(params)}`);
  if (req.query.error) return back({ google_connect: 'denied' });
  let state;
  try { state = gads.parseState(String(req.query.state || '')); } catch (e) { return back({ google_connect: 'error', reason: e.message || 'Invalid link.' }); }
  try {
    const t = await gads.exchangeCode(String(req.query.code || ''));
    if (!t.scopes.includes('https://www.googleapis.com/auth/adwords')) return back({ google_connect: 'error', reason: 'Allow CurveLead to manage your Google Ads campaigns on the Google screen.' });
    if (!t.refresh_token) return back({ google_connect: 'error', reason: 'Google didn\'t return a lasting connection. Remove CurveLead from your Google account permissions and connect again.' });
    const tokenId = await saveGoogleToken({ tenantId: state.tenantId, userId: state.userId, externalUserId: t.sub || t.email || 'google', refreshToken: t.refresh_token, scopes: t.scopes });
    const found = await discoverGoogleAccounts({ tenantId: state.tenantId, tokenId, accessToken: t.access_token });
    await syncAccountsOf(state.tenantId, tokenId);
    back({ google_connect: 'success', accounts: String(found.accounts), ...(found.skipped.length ? { skipped: String(found.skipped.length) } : {}) });
  } catch (e) {
    console.error('[google-ads] callback:', e.message);
    back({ google_connect: 'error', reason: e.name === 'GoogleAdsError' ? e.message : 'Could not connect Google Ads. Please try again.' });
  }
};

// POST /api/ads/google/refresh — re-list accounts from the saved connection(s) and sync them.
const refresh = async (req, res) => {
  try {
    const { rows } = await query("SELECT id, token_encrypted, key_version FROM ad_oauth_tokens WHERE tenant_id = $1 AND provider = 'google' AND status = 'active'", [req.tenantId]);
    if (!rows.length) return res.status(404).json({ error: 'Connect Google Ads first.' });
    let accounts = 0;
    const skipped = [];
    for (const t of rows) {
      const accessToken = await gads.accessToken(decryptToken(t.token_encrypted, t.key_version));
      const found = await discoverGoogleAccounts({ tenantId: req.tenantId, tokenId: t.id, accessToken });
      accounts += found.accounts; skipped.push(...found.skipped);
      await syncAccountsOf(req.tenantId, t.id);
    }
    res.json({ accounts, skipped });
  } catch (e) {
    if (e.auth) await query("UPDATE ad_oauth_tokens SET status = 'expired', last_error = $2, updated_at = now() WHERE tenant_id = $1 AND provider = 'google'", [req.tenantId, e.message]).catch(() => {});
    fail('Refresh Google Ads accounts')(e, res);
  }
};

// ── AI search ads (Phase 7b) ────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const aiRoute = (label, fn) => async (req, res) => {
  try {
    if (req.params.id && !UUID.test(req.params.id)) return res.status(422).json({ error: 'Invalid id.' });
    res.json(await fn(req));
  } catch (e) { fail(label)(e, res); }
};
const aiCreateDraft = aiRoute('Google AI draft', (req) => aiSearch.generateDraft({ tenantId: req.tenantId, userId: req.user.id, brief: req.body?.brief }));
const aiListDrafts = aiRoute('List Google AI drafts', async (req) => ({ drafts: await aiSearch.listDrafts(req.tenantId) }));
const aiGetDraft = aiRoute('Get Google AI draft', (req) => aiSearch.getDraft(req.tenantId, req.params.id));
const aiUpdateDraft = aiRoute('Update Google AI draft', (req) => aiSearch.updateDraft({ tenantId: req.tenantId, id: req.params.id, draft: req.body?.draft }));
const aiCreate = aiRoute('Create search campaign in Google Ads', (req) => aiSearch.createOnGoogle({ tenantId: req.tenantId, userId: req.user.id, id: req.params.id }));
const aiActivate = aiRoute('Activate search campaign', (req) => aiSearch.activate({ tenantId: req.tenantId, userId: req.user.id, id: req.params.id, confirm: req.body?.confirm }));

module.exports = { status, connectUrl, callback, refresh, aiCreateDraft, aiListDrafts, aiGetDraft, aiUpdateDraft, aiCreate, aiActivate };
