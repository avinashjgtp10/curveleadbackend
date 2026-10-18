const axios = require('axios');
const { decryptSecret } = require('../../utils/cryptoSecrets');

// Google Business Profile posts ("local posts"), using the workspace's existing Google
// connection (Settings → Integrations → Google, the same one the reviews page uses).
// Needs Business Profile API access, which Google grants separately from OAuth.

class GbpError extends Error {
  constructor(message, { retryable = false, status, reason, activationUrl, service } = {}) {
    super(message); this.name = 'GbpError'; this.retryable = retryable; this.status = status;
    this.reason = reason; this.activationUrl = activationUrl; this.service = service; // Google's own diagnosis, for logs
  }
}

const wrap = (e, what) => {
  if (e instanceof GbpError) return e;
  const status = e.response?.status;
  const msg = e.response?.data?.error?.message || e.message;
  if (status === 403) {
    // Google says WHY in error.details: SERVICE_DISABLED (API not switched on in the Cloud project),
    // or PERMISSION_DENIED / not allowlisted (project not approved for this API).
    const detail = (e.response?.data?.error?.details || []).find(d => d.reason) || {};
    return new GbpError(`Google refused ${what}: ${msg}. The Business Profile API must be enabled and approved for CurveLead's Google project.`,
      { status, reason: detail.reason || e.response?.data?.error?.status, activationUrl: detail.metadata?.activationUrl, service: detail.metadata?.serviceTitle || detail.metadata?.service });
  }
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

// The profile fields we read (Business Information API). Read-only: nothing here edits a listing.
const LOCATION_READ_MASK = 'name,title,storefrontAddress,phoneNumbers,websiteUri,categories,metadata,profile,regularHours';

// Google's location -> the flat shape the profile score and the page use. Missing fields stay null/empty, never invented.
const mapLocation = (l = {}) => {
  const a = l.storefrontAddress || {};
  const cats = l.categories || {};
  const periods = (l.regularHours && l.regularHours.periods) || [];
  return {
    name: l.title || null,
    address: { lines: a.addressLines || [], locality: a.locality || null, region: a.administrativeArea || null, postal_code: a.postalCode || null, country: a.regionCode || null },
    phone: (l.phoneNumbers && l.phoneNumbers.primaryPhone) || null,
    additional_phones: (l.phoneNumbers && l.phoneNumbers.additionalPhones) || [],
    website: l.websiteUri || null,
    primary_category: (cats.primaryCategory && cats.primaryCategory.displayName) || null,
    additional_categories: (cats.additionalCategories || []).map((c) => c.displayName).filter(Boolean),
    description: (l.profile && l.profile.description) || null,
    open_days: [...new Set(periods.map((p) => p.openDay).filter(Boolean))],
    verified: l.metadata ? l.metadata.hasVoiceOfMerchant === true : null,   // null = Google did not say
    maps_url: (l.metadata && l.metadata.mapsUri) || null,
    review_url: (l.metadata && l.metadata.newReviewUri) || null,
  };
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
          ...auth, params: { readMask: LOCATION_READ_MASK, pageSize: 100, pageToken },
        });
        for (const l of data.locations || []) {
          const addr = l.storefrontAddress;
          out.push({ external_id: l.name, parent_external_id: a.name, name: l.title || l.name,
            address: addr ? [...(addr.addressLines || []), addr.locality].filter(Boolean).join(', ') : null,
            details: mapLocation(l) });
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

// ---- Insights (Business Profile Performance API) ------------------------------------------------------------------------------------
const INSIGHT_METRICS = ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS'];
const ymd = (d) => ({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });

// location: 'locations/123'. from/to: Date (inclusive days). Returns the raw multiDailyMetricTimeSeries array.
const fetchInsights = async ({ accessToken, location, from, to, http = axios }) => {
  if (!/^locations\/\d+$/.test(location || '')) throw new GbpError('Choose one of your business locations.', { status: 400 });
  const q = new URLSearchParams();
  for (const m of INSIGHT_METRICS) q.append('dailyMetrics', m);
  const f = ymd(from); const t = ymd(to);
  q.set('dailyRange.startDate.year', f.y); q.set('dailyRange.startDate.month', f.m); q.set('dailyRange.startDate.day', f.d);
  q.set('dailyRange.endDate.year', t.y); q.set('dailyRange.endDate.month', t.m); q.set('dailyRange.endDate.day', t.d);
  try {
    const { data } = await http.get(`https://businessprofileperformance.googleapis.com/v1/${location}:fetchMultiDailyMetricsTimeSeries?${q.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    return data.multiDailyMetricTimeSeries || [];
  } catch (e) { throw wrap(e, 'reading profile insights'); }
};

module.exports = { accessTokenFor, listLocations, buildLocalPost, publishToGbp, fetchInsights, mapLocation, LOCATION_READ_MASK, INSIGHT_METRICS, GbpError };
