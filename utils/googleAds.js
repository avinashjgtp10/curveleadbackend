const axios = require('axios');
const { encryptSecret, decryptSecret } = require('./cryptoSecrets');

// Google Ads API over REST (no SDK). Every call needs the developer token
// (GOOGLE_ADS_DEVELOPER_TOKEN, from the manager account's API Center) and an OAuth
// access token with the adwords scope. Accounts reached through a manager account
// also need its id as login-customer-id.

const API_VERSION = () => process.env.GOOGLE_ADS_API_VERSION || 'v22';
const API = () => `https://googleads.googleapis.com/${API_VERSION()}`;
const SCOPES = ['https://www.googleapis.com/auth/adwords', 'openid', 'email'];
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

class GoogleAdsError extends Error {
  constructor(message, { status, code, retryable = false, auth = false } = {}) {
    super(message); this.name = 'GoogleAdsError'; this.status = status; this.code = code; this.retryable = retryable; this.auth = auth;
  }
}

const configured = () => !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const redirectUri = () => process.env.GOOGLE_ADS_OAUTH_REDIRECT_URI || `${process.env.API_URL || 'https://curvelead.com'}/api/ads/google/callback`;
const digits = (id) => String(id || '').replace(/\D/g, '');

// ── OAuth ───────────────────────────────────────────────────────────────────
// state = encrypted { tenantId, userId, ts } so the callback can't be pointed at another workspace.
const buildState = ({ tenantId, userId }) => encryptSecret(JSON.stringify({ tenantId, userId, ts: Date.now(), k: 'gads' }));
const parseState = (state) => {
  const s = JSON.parse(decryptSecret(state));
  if (s.k !== 'gads') throw new Error('Invalid connection link.');
  if (Date.now() - s.ts > STATE_MAX_AGE_MS) throw new Error('This connection link has expired — please try connecting again.');
  return s;
};

const authUrl = ({ tenantId, userId }) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code',
  scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
  state: buildState({ tenantId, userId }),
})}`;

const tokenRequest = async (params, http = axios) => {
  try {
    const { data } = await http.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return data;
  } catch (e) {
    if (e.response?.data?.error === 'invalid_grant') throw new GoogleAdsError('The Google Ads connection has expired or was revoked — reconnect Google Ads.', { status: 401, auth: true });
    throw new GoogleAdsError(`Google sign-in failed: ${e.response?.data?.error_description || e.message}`, { status: e.response?.status, retryable: !e.response || e.response.status >= 500 });
  }
};

// { refresh_token, access_token, scopes[], email, sub }
const exchangeCode = async (code, http) => {
  const data = await tokenRequest({ code, redirect_uri: redirectUri(), grant_type: 'authorization_code' }, http);
  let claims = {};
  try { claims = JSON.parse(Buffer.from(String(data.id_token || '').split('.')[1] || '', 'base64url').toString('utf8')); } catch { /* optional */ }
  return { refresh_token: data.refresh_token, access_token: data.access_token, scopes: String(data.scope || '').split(' ').filter(Boolean), email: claims.email || null, sub: claims.sub || null };
};
const accessToken = async (refreshToken, http) => (await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' }, http)).access_token;

// ── API calls ───────────────────────────────────────────────────────────────
// Google returns errors as { error: { status, message, details: [{ errors: [{ errorCode: { authorizationError: 'X' }, message }] }] } }.
const ERROR_TEXT = {
  DEVELOPER_TOKEN_NOT_APPROVED: 'CurveLead\'s Google Ads developer token only has test access, so it can\'t read real accounts yet. Apply for Basic Access in the manager account\'s API Center.',
  DEVELOPER_TOKEN_PROHIBITED: 'The Google Ads developer token isn\'t allowed for this Google Cloud project.',
  USER_PERMISSION_DENIED: 'This Google user can\'t access that Google Ads account (or it must be reached through its manager account).',
  CUSTOMER_NOT_ENABLED: 'This Google Ads account isn\'t active (cancelled or not set up yet).',
  NOT_ADS_USER: 'This Google login has no Google Ads accounts.',
  OAUTH_TOKEN_REVOKED: 'The Google Ads connection was revoked — reconnect Google Ads.',
  OAUTH_TOKEN_EXPIRED: 'The Google Ads connection has expired — reconnect Google Ads.',
};
const errorCodeOf = (body) => {
  for (const d of body?.error?.details || []) {
    for (const e of d.errors || []) {
      const code = Object.values(e.errorCode || {})[0];
      if (code) return { code: String(code), message: e.message };
    }
  }
  return { code: body?.error?.status || null, message: body?.error?.message };
};
const toError = (e) => {
  if (e instanceof GoogleAdsError) return e;
  const status = e.response?.status;
  const { code, message } = errorCodeOf(e.response?.data);
  const retryable = !status || status === 429 || status >= 500 || code === 'RESOURCE_EXHAUSTED' || code === 'RESOURCE_TEMPORARILY_EXHAUSTED';
  return new GoogleAdsError(ERROR_TEXT[code] || `Google Ads: ${message || e.message}`, { status, code, retryable, auth: status === 401 || /OAUTH_TOKEN/.test(code || '') });
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const call = async ({ method = 'GET', path, data, accessToken: token, loginCustomerId, http = axios, retries = 3, _sleep = sleep }) => {
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new GoogleAdsError('Google Ads isn\'t set up on this server (GOOGLE_ADS_DEVELOPER_TOKEN is missing).', { status: 503 });
  for (let attempt = 0; ; attempt++) {
    try {
      const { data: body } = await http.request({
        method, url: `${API()}${path}`, data, timeout: 60000,
        headers: {
          Authorization: `Bearer ${token}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          ...(loginCustomerId ? { 'login-customer-id': digits(loginCustomerId) } : {}),
        },
      });
      return body;
    } catch (e) {
      const err = toError(e);
      if (!err.retryable || attempt >= retries) throw err;
      await _sleep(Math.min(60000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 500));
    }
  }
};

// GAQL search with paging. Returns every row.
const search = async ({ customerId, gaql, accessToken: token, loginCustomerId, http, _sleep, maxPages = 100 }) => {
  const rows = [];
  let pageToken;
  let page = 0;
  do {
    const body = await call({ method: 'POST', path: `/customers/${digits(customerId)}/googleAds:search`,
      data: { query: gaql, ...(pageToken ? { pageToken } : {}) }, accessToken: token, loginCustomerId, http, _sleep });
    rows.push(...(body.results || []));
    pageToken = body.nextPageToken;
  } while (pageToken && ++page < maxPages);
  return rows;
};

const listAccessibleCustomers = async ({ accessToken: token, http }) =>
  ((await call({ path: '/customers:listAccessibleCustomers', accessToken: token, http })).resourceNames || []).map(n => digits(n));

module.exports = { configured, redirectUri, authUrl, parseState, exchangeCode, accessToken, call, search, listAccessibleCustomers,
  toError, GoogleAdsError, digits, API_VERSION, SCOPES };
