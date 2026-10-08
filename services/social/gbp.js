const axios = require('axios');
const { decryptSecret } = require('../../utils/cryptoSecrets');

// Google Business Profile posts ("local posts"), using the workspace's existing Google
// connection (Settings → Integrations → Google, the same one the reviews page uses).
// Needs Business Profile API access, which Google grants separately from OAuth.

class GbpError extends Error {
  constructor(message, { retryable = false, status } = {}) { super(message); this.name = 'GbpError'; this.retryable = retryable; this.status = status; }
}

const wrap = (e, what) => {
  if (e instanceof GbpError) return e;
  const status = e.response?.status;
  const msg = e.response?.data?.error?.message || e.message;
  if (status === 403) return new GbpError(`Google refused ${what}: ${msg}. The Business Profile API must be enabled and approved for CurveLead's Google project.`, { status });
  if (status === 401) return new GbpError('The Google connection has expired — reconnect Google in Integrations.', { status });
  return new GbpError(`Google ${what} failed: ${msg}`, { retryable: !status || status === 429 || status >= 500, status });
};

const accessTokenFor = async (settings, http = axios) => {
  if (!settings?.gmb_refresh_token_encrypted) throw new GbpError('Google isn\'t connected — connect it in Integrations first.');
  try {
    const { data } = await http.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: decryptSecret(settings.gmb_refresh_token_encrypted), grant_type: 'refresh_token',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return data.access_token;
  } catch (e) {
    if (e.response?.data?.error === 'invalid_grant') throw new GbpError('The Google connection has expired — reconnect Google in Integrations.');
    throw wrap(e, 'sign-in');
  }
};

// Every location the connected Google account manages: [{ external_id: 'locations/1', parent_external_id: 'accounts/2', name, address }]
const listLocations = async ({ accessToken, http = axios }) => {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  try {
    const accounts = (await http.get('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', auth)).data.accounts || [];
    const out = [];
    for (const a of accounts) {
      let pageToken;
      do {
        const { data } = await http.get(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations`, {
          ...auth, params: { readMask: 'name,title,storefrontAddress', pageSize: 100, pageToken },
        });
        for (const l of data.locations || []) {
          const addr = l.storefrontAddress;
          out.push({ external_id: l.name, parent_external_id: a.name, name: l.title || l.name,
            address: addr ? [...(addr.addressLines || []), addr.locality].filter(Boolean).join(', ') : null });
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    }
    return out;
  } catch (e) { throw wrap(e, 'listing your business locations'); }
};

// Builds the localPosts body. media: [{ type: 'image', url }] (at most one photo).
const buildLocalPost = ({ caption, link_url, media = [], languageCode = 'en' }) => ({
  languageCode,
  summary: caption,
  topicType: 'STANDARD',
  ...(media[0] ? { media: [{ mediaFormat: 'PHOTO', sourceUrl: media[0].url }] } : {}),
  ...(link_url ? { callToAction: { actionType: 'LEARN_MORE', url: link_url } } : {}),
});

// Returns { external_post_id, permalink }.
const publishToGbp = async ({ accountName, locationName, accessToken, caption, link_url, media, http = axios }) => {
  try {
    const { data } = await http.post(`https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/localPosts`,
      buildLocalPost({ caption, link_url, media }), { headers: { Authorization: `Bearer ${accessToken}` } });
    return { external_post_id: data.name, permalink: data.searchUrl || null };
  } catch (e) { throw wrap(e, 'posting'); }
};

module.exports = { accessTokenFor, listLocations, buildLocalPost, publishToGbp, GbpError };
