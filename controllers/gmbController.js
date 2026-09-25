const { query } = require('../config/db');
const { generateReviewRequestMessage } = require('../services/groqService');
const { DEFAULT_TEMPLATE } = require('../utils/googleReviewRequest');
const { encryptSecret } = require('../utils/cryptoSecrets');
const { getAuthUrl, parseState, exchangeCodeForTokens, fetchGmbAccounts } = require('../utils/googleOAuth');

const getSettings = async (tenantId) => {
  const r = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  return r.rows[0]?.settings || {};
};

const saveSettings = async (tenantId, patch) => {
  const current = await getSettings(tenantId);
  await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({ ...current, ...patch }), tenantId]);
};

// GET /api/gmb/settings
const getGmbSettings = async (req, res) => {
  try {
    const s = await getSettings(req.tenantId);
    res.json({
      enabled: !!s.google_review_request_enabled,
      review_link: s.google_review_link || '',
      message: s.google_review_request_message || DEFAULT_TEMPLATE,
      gmb_connected: !!s.gmb_refresh_token_encrypted,
      gmb_account_name: s.gmb_account_name || null,
      gmb_locations_loaded: !!s.gmb_account_id,
    });
  } catch (e) { console.error('getGmbSettings:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/gmb/settings
const updateGmbSettings = async (req, res) => {
  try {
    const { enabled, review_link, message } = req.body;
    const patch = {};
    if (enabled !== undefined) patch.google_review_request_enabled = !!enabled;
    if (review_link !== undefined) patch.google_review_link = String(review_link).trim().slice(0, 500);
    if (message !== undefined) patch.google_review_request_message = String(message).trim().slice(0, 1000);
    await saveSettings(req.tenantId, patch);
    res.json({ ok: true });
  } catch (e) { console.error('updateGmbSettings:', e.message); res.status(500).json({ error: 'Failed to save.' }); }
};

// POST /api/gmb/draft-message — AI drafts the review-request message from the
// business's own AI Auto-reply knowledge (tone/about), if any has been filled in.
const draftReviewMessage = async (req, res) => {
  try {
    const tenant = (await query('SELECT name, settings FROM tenants WHERE id = $1', [req.tenantId])).rows[0];
    const message = await generateReviewRequestMessage({
      businessName: tenant?.name,
      knowledge: tenant?.settings?.ai_knowledge,
    });
    res.json({ message });
  } catch (e) {
    console.error('draftReviewMessage:', e.message);
    res.status(502).json({ error: e.message || 'Failed to draft a message.' });
  }
};

// GET /api/gmb/oauth/connect — returns the Google consent URL for the frontend to
// navigate the browser to (not a server-side redirect: this call carries our own
// auth header, which a plain browser navigation to this URL wouldn't have).
const connectGmb = async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(501).json({ error: 'Google Business Profile connection is not configured on the server yet.' });
    }
    res.json({ url: getAuthUrl(req.tenantId) });
  } catch (e) { console.error('connectGmb:', e.message); res.status(500).json({ error: 'Failed to start connection.' }); }
};

// GET /api/gmb/oauth/callback — Google redirects the user's browser here directly
// after consent, with no auth header of ours attached. Public route; the tenant
// comes from the signed `state` param instead of req.tenantId.
const gmbOauthCallback = async (req, res) => {
  const frontendBase = `${process.env.FRONTEND_URL || 'https://curvelead.com'}/gmb`;
  try {
    const { code, state, error: googleError } = req.query;
    if (googleError) return res.redirect(`${frontendBase}?gmb_connect=denied`);
    if (!code || !state) return res.redirect(`${frontendBase}?gmb_connect=error`);

    const tenantId = parseState(state);
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Google only omits this if the tenant had already granted consent before
      // without us storing a refresh token — prompt=consent should prevent this,
      // but if it happens the fix is revoking access in their Google account and retrying.
      return res.redirect(`${frontendBase}?gmb_connect=no_refresh_token`);
    }

    const patch = {
      gmb_refresh_token_encrypted: encryptSecret(tokens.refresh_token),
      gmb_connected_at: new Date().toISOString(),
    };

    // Best-effort — the Business Profile API access request may still be pending
    // with Google, in which case this 403s and we simply store the connection
    // without location details yet, to fill in once access is granted.
    try {
      const accounts = await fetchGmbAccounts(tokens.access_token);
      if (accounts[0]) {
        patch.gmb_account_id = accounts[0].name;
        patch.gmb_account_name = accounts[0].accountName || null;
      }
    } catch (e) {
      console.warn('fetchGmbAccounts (likely pending API access):', e.response?.data || e.message);
    }

    const current = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [
      JSON.stringify({ ...(current.rows[0]?.settings || {}), ...patch }), tenantId,
    ]);

    res.redirect(`${frontendBase}?gmb_connect=success`);
  } catch (e) {
    console.error('gmbOauthCallback:', e.response?.data || e.message);
    res.redirect(`${frontendBase}?gmb_connect=error`);
  }
};

// POST /api/gmb/oauth/disconnect
const disconnectGmb = async (req, res) => {
  try {
    const current = await getSettings(req.tenantId);
    const { gmb_refresh_token_encrypted, gmb_connected_at, gmb_account_id, gmb_account_name, ...rest } = current;
    await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(rest), req.tenantId]);
    res.json({ ok: true });
  } catch (e) { console.error('disconnectGmb:', e.message); res.status(500).json({ error: 'Failed to disconnect.' }); }
};

module.exports = { getGmbSettings, updateGmbSettings, draftReviewMessage, connectGmb, gmbOauthCallback, disconnectGmb };
