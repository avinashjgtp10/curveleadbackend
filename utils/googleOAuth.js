const axios = require('axios');
const { encryptSecret, decryptSecret } = require('./cryptoSecrets');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // the round trip through Google's consent screen should take under 10 minutes

// The OAuth "state" param carries which tenant initiated this, through a redirect
// Google controls — encrypted (not just base64) so it can't be tampered with to
// attach a connection to a different tenant, and timestamped so a stale/replayed
// callback link is rejected.
// URLSearchParams (below) and Express's query parser both handle percent-encoding
// on their own — no manual encodeURIComponent needed here, it would just double-encode.
const buildState = (tenantId) => encryptSecret(JSON.stringify({ tenantId, ts: Date.now() }));

const parseState = (state) => {
  const { tenantId, ts } = JSON.parse(decryptSecret(state));
  if (Date.now() - ts > STATE_MAX_AGE_MS) throw new Error('This connection link has expired — please try connecting again.');
  return tenantId;
};

const getAuthUrl = (tenantId) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // forces Google to return a refresh_token every time, not just on first-ever consent
    state: buildState(tenantId),
  });
  return `${AUTH_URL}?${params.toString()}`;
};

const exchangeCodeForTokens = async (code) => {
  const response = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    code,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return response.data; // { access_token, refresh_token, expires_in, ... }
};

// Best-effort: this call needs the Business Profile API access Google grants
// separately from OAuth itself, so it's expected to fail with a permission error
// until that access request is approved. The connection is still saved either way.
const fetchGmbAccounts = async (accessToken) => {
  const response = await axios.get('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data.accounts || [];
};

module.exports = { getAuthUrl, parseState, exchangeCodeForTokens, fetchGmbAccounts };
