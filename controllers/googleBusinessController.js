const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// ── Google Business Profile OAuth integration ───────────────────────────────
//
// IMPORTANT — this will 403 until Google approves API access for this OAuth
// client. The Business Profile APIs (mybusinessaccountmanagement,
// mybusinessbusinessinformation, and the legacy mybusiness v4 API used here
// for reviews) are gated behind a manual approval process
// (https://developers.google.com/my-business/content/prereqs#request-access)
// — enabling them in Cloud Console is not enough on its own. See the setup
// steps in README.md.
//
// Tokens are stored in tenants.settings JSONB, matching how Meta/WhatsApp
// credentials are already stored per-tenant elsewhere in this codebase.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const LOCATIONS_URL = (account) => `https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations?readMask=name,title,phoneNumbers,storefrontAddress,metadata`;
const REVIEWS_URL = (account, location, pageToken) =>
  `https://mybusiness.googleapis.com/v4/${account}/${location}/reviews${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`;

const oauthConfigured = () => !!(process.env.GOOGLE_BUSINESS_CLIENT_ID && process.env.GOOGLE_BUSINESS_CLIENT_SECRET && process.env.GOOGLE_BUSINESS_REDIRECT_URI);

const getTenantSettings = async (tenantId) => {
  const result = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  return result.rows[0]?.settings || {};
};

const saveTenantSettings = async (tenantId, patch) => {
  const current = await getTenantSettings(tenantId);
  const updated = { ...current, ...patch };
  await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify(updated), tenantId]);
  return updated;
};

// ── GET /api/integrations/google-business/auth ─────────────────────────────
// Returns the consent-screen URL for the frontend to redirect the browser to.
const getAuthUrl = async (req, res) => {
  if (!oauthConfigured()) {
    return res.status(500).json({ error: 'GOOGLE_BUSINESS_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI not configured on server.' });
  }
  // The Google redirect back to our callback is a plain browser navigation —
  // no Authorization header — so tenant identity has to ride along in `state`,
  // signed so it can't be tampered with.
  const state = jwt.sign({ tenantId: req.tenantId }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_BUSINESS_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_BUSINESS_REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',   // required to get a refresh_token
    prompt: 'consent',        // forces refresh_token on every connect, not just the first
    state,
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
};

// ── GET /api/integrations/google-business/callback ──────────────────────────
// Public — Google redirects the browser here directly, so this route carries
// no auth middleware. Tenant identity comes from the signed `state`.
const oauthCallback = async (req, res) => {
  const frontend = process.env.FRONTEND_URL || 'https://curvelead.com';
  const { code, state, error: googleError } = req.query;

  if (googleError) {
    return res.redirect(`${frontend}/settings?google_business=error&message=${encodeURIComponent(googleError)}`);
  }

  let tenantId;
  try {
    ({ tenantId } = jwt.verify(state, process.env.JWT_SECRET));
  } catch {
    return res.redirect(`${frontend}/settings?google_business=error&message=${encodeURIComponent('Invalid or expired connection request.')}`);
  }

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_BUSINESS_CLIENT_ID,
        client_secret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_BUSINESS_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    const userRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const userInfo = await userRes.json();

    await saveTenantSettings(tenantId, {
      google_business_connected: true,
      google_business_needs_reauth: false,
      google_business_account_email: userInfo.email || null,
      google_business_access_token: tokens.access_token,
      // Google only returns refresh_token on first consent (or when prompt=consent
      // forces re-grant, which we always request) — keep the old one otherwise.
      ...(tokens.refresh_token ? { google_business_refresh_token: tokens.refresh_token } : {}),
      google_business_token_expiry: Date.now() + tokens.expires_in * 1000,
      google_business_connected_at: new Date().toISOString(),
    });

    res.redirect(`${frontend}/settings?google_business=connected`);
  } catch (e) {
    console.error('googleBusiness oauthCallback error:', e.message);
    res.redirect(`${frontend}/settings?google_business=error&message=${encodeURIComponent(e.message)}`);
  }
};

// Returns a valid access token, refreshing it first if it's expired or about
// to expire. Throws a NEEDS_REAUTH-tagged error if the refresh token itself
// has been revoked (user removed access from their Google account, etc.) —
// callers should surface that as "please reconnect", not a generic failure.
const getValidAccessToken = async (tenantId) => {
  const settings = await getTenantSettings(tenantId);
  if (!settings.google_business_connected || !settings.google_business_refresh_token) {
    const err = new Error('Google Business Profile is not connected.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const expiresInMs = (settings.google_business_token_expiry || 0) - Date.now();
  if (expiresInMs > 60_000) return settings.google_business_access_token; // still valid for >1 min

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: settings.google_business_refresh_token,
      client_id: process.env.GOOGLE_BUSINESS_CLIENT_ID,
      client_secret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const tokens = await tokenRes.json();

  if (tokens.error) {
    if (tokens.error === 'invalid_grant') {
      await saveTenantSettings(tenantId, { google_business_needs_reauth: true });
      const err = new Error('Google Business Profile access was revoked. Please reconnect.');
      err.code = 'NEEDS_REAUTH';
      throw err;
    }
    throw new Error(tokens.error_description || tokens.error);
  }

  await saveTenantSettings(tenantId, {
    google_business_access_token: tokens.access_token,
    google_business_token_expiry: Date.now() + tokens.expires_in * 1000,
  });
  return tokens.access_token;
};

const googleGet = async (url, accessToken) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
};

// ── POST /api/integrations/google-business/sync ─────────────────────────────
// Pulls locations + reviews for the connected account and upserts them.
// Partial-failure tolerant: one bad location doesn't abort the rest.
const syncLocationsAndReviews = async (req, res) => {
  try {
    const accessToken = await getValidAccessToken(req.tenantId);

    const accountsData = await googleGet(ACCOUNTS_URL, accessToken);
    const accounts = accountsData.accounts || [];
    if (accounts.length === 0) {
      return res.json({ locations: [], errors: [], synced_at: new Date().toISOString(), message: 'No Business Profile accounts found for this Google login.' });
    }
    const account = accounts[0].name; // "accounts/{id}"

    const locationsData = await googleGet(LOCATIONS_URL(account), accessToken);
    const locations = locationsData.locations || [];

    const results = [];
    const errors = [];

    for (const loc of locations) {
      try {
        const reviewsData = await googleGet(REVIEWS_URL(account, loc.name), accessToken);
        const reviews = reviewsData.reviews || [];

        const locRow = await query(
          `INSERT INTO gbp_locations (tenant_id, google_account_id, google_location_id, title, address, phone, maps_uri, average_rating, review_count, last_synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
           ON CONFLICT (tenant_id, google_location_id) DO UPDATE SET
             title = EXCLUDED.title, address = EXCLUDED.address, phone = EXCLUDED.phone,
             maps_uri = EXCLUDED.maps_uri, average_rating = EXCLUDED.average_rating,
             review_count = EXCLUDED.review_count, last_synced_at = NOW()
           RETURNING id`,
          [
            req.tenantId, account, loc.name, loc.title || null,
            loc.storefrontAddress ? [loc.storefrontAddress.addressLines, loc.storefrontAddress.locality, loc.storefrontAddress.administrativeArea].flat().filter(Boolean).join(', ') : null,
            loc.phoneNumbers?.primaryPhone || null,
            loc.metadata?.mapsUri || null,
            reviewsData.averageRating || null,
            reviewsData.totalReviewCount || reviews.length,
          ]
        );
        const locationDbId = locRow.rows[0].id;

        for (const review of reviews) {
          await query(
            `INSERT INTO gbp_reviews (tenant_id, location_id, google_review_id, reviewer_name, reviewer_photo_url, star_rating, comment, review_reply, create_time, update_time)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (tenant_id, google_review_id) DO UPDATE SET
               star_rating = EXCLUDED.star_rating, comment = EXCLUDED.comment,
               review_reply = EXCLUDED.review_reply, update_time = EXCLUDED.update_time`,
            [
              req.tenantId, locationDbId, review.reviewId,
              review.reviewer?.displayName || 'Anonymous', review.reviewer?.profilePhotoUrl || null,
              review.starRating || null, review.comment || null,
              review.reviewReply?.comment || null,
              review.createTime || null, review.updateTime || null,
            ]
          );
        }

        results.push({ location: loc.title, review_count: reviews.length });
      } catch (e) {
        errors.push({ location: loc.title || loc.name, error: e.message });
      }
    }

    res.json({ locations: results, errors, synced_at: new Date().toISOString() });
  } catch (e) {
    if (e.code === 'NOT_CONNECTED') return res.status(400).json({ error: e.message });
    if (e.code === 'NEEDS_REAUTH') return res.status(409).json({ error: e.message, code: 'NEEDS_REAUTH' });
    console.error('syncLocationsAndReviews error:', e.message);
    res.status(500).json({ error: 'Sync failed. Please try again.' });
  }
};

// ── GET /api/integrations/google-business/status ────────────────────────────
// Cached status — reads DB only, no live Google API call (keeps this cheap
// to poll from a settings page).
const getStatus = async (req, res) => {
  try {
    const settings = await getTenantSettings(req.tenantId);
    const locationsResult = await query(
      `SELECT id, title, address, average_rating, review_count, last_synced_at
       FROM gbp_locations WHERE tenant_id = $1 ORDER BY title`,
      [req.tenantId]
    );

    res.json({
      connected: !!settings.google_business_connected,
      needs_reauth: !!settings.google_business_needs_reauth,
      account_email: settings.google_business_account_email || null,
      connected_at: settings.google_business_connected_at || null,
      locations: locationsResult.rows,
    });
  } catch (e) {
    console.error('getStatus error:', e.message);
    res.status(500).json({ error: 'Failed to load status.' });
  }
};

// ── DELETE /api/integrations/google-business ─────────────────────────────────
// Disconnects — revokes the token with Google and clears connection fields.
// Historical locations/reviews are kept (not deleted) unless the caller asks.
const disconnect = async (req, res) => {
  try {
    const settings = await getTenantSettings(req.tenantId);
    if (settings.google_business_refresh_token) {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(settings.google_business_refresh_token)}`, { method: 'POST' }).catch(() => {});
    }
    await saveTenantSettings(req.tenantId, {
      google_business_connected: false,
      google_business_needs_reauth: false,
      google_business_access_token: null,
      google_business_refresh_token: null,
      google_business_token_expiry: null,
      google_business_account_email: null,
    });
    res.json({ success: true });
  } catch (e) {
    console.error('disconnect error:', e.message);
    res.status(500).json({ error: 'Failed to disconnect.' });
  }
};

module.exports = { getAuthUrl, oauthCallback, syncLocationsAndReviews, getStatus, disconnect };
