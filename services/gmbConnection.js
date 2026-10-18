const { accessTokenFor, listLocations, fetchInsights } = require('./social/gbp');
const { profileHealth, summarizeInsights } = require('./gbpProfile');

// Re-checks a workspace's Google Business Profile connection without disconnecting it: signs in
// with the stored refresh token, lists the Google accounts and locations, and reports what to
// store. Connections made before Google approved CurveLead's API access never filled these in.
//
// Returns { ok: true, accountId, accountName, locations } or { ok: false, code, message, detail }.
// `message` is safe to show a customer; `detail` (Google's diagnosis) is for server logs only,
// because the Google Cloud project belongs to CurveLead, not to the customer.
async function refreshGmbConnection(settings, deps = {}) {
  const getToken = deps.accessTokenFor || accessTokenFor;
  const getLocations = deps.listLocations || listLocations;
  try {
    const accessToken = await getToken(settings);
    const locations = await getLocations({ accessToken });
    if (!locations.length) {
      return { ok: false, code: 'no_locations', message: "Google is connected, but this Google account doesn't manage any business locations yet. Connect the account that owns your Business Profile." };
    }
    const accountId = locations[0].parent_external_id;
    return { ok: true, accountId, accountName: settings?.gmb_account_name || null, locations: locations.map(l => ({ id: l.external_id, name: l.name, address: l.address })) };
  } catch (e) {
    return explainError(e);
  }
}

// Google/GbpError -> { ok: false, code, message, detail }. `message` is safe for a customer, `detail` is for logs.
function explainError(e) {
  const detail = [e.reason, e.service, e.activationUrl].filter(Boolean).join(' · ') || e.message;
  if (/expired|isn't connected|reconnect/i.test(e.message)) return { ok: false, code: 'reconnect', message: 'The Google connection has expired. Disconnect and connect Google again.', detail };
  if (e.status === 403) {
    return e.reason === 'SERVICE_DISABLED'
      ? { ok: false, code: 'api_not_enabled', message: "CurveLead's Google access is still being switched on. Please try again in a few minutes, or contact support if it persists.", detail }
      : { ok: false, code: 'not_approved', message: "Google hasn't opened Business Profile access for this account yet. Please try again shortly, or contact support if it persists.", detail };
  }
  if (e.status === 429) return { ok: false, code: 'rate_limited', message: 'Google is busy right now. Please try again in a minute.', detail };
  return { ok: false, code: 'error', message: "Couldn't reach Google just now. Please try again.", detail };
}

// Every location with its profile details and completeness score. Read-only.
async function loadProfiles(settings, deps = {}) {
  try {
    const accessToken = await (deps.accessTokenFor || accessTokenFor)(settings);
    const locations = await (deps.listLocations || listLocations)({ accessToken });
    return { ok: true, locations: locations.map((l) => ({ id: l.external_id, name: l.name, address: l.address, details: l.details || null, health: profileHealth(l.details || {}) })) };
  } catch (e) { return explainError(e); }
}

// Search/maps views and customer actions for one location over the last `days` days (default 30, at most 540: Google keeps ~18 months).
async function loadInsights(settings, { location, days = 30, now = new Date() } = {}, deps = {}) {
  const n = Math.min(540, Math.max(1, Math.floor(Number(days)) || 30));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2));   // the latest days are not final yet
  const from = new Date(to.getTime() - (n - 1) * 864e5);
  try {
    const accessToken = await (deps.accessTokenFor || accessTokenFor)(settings);
    const rows = await (deps.fetchInsights || fetchInsights)({ accessToken, location, from, to });
    const iso = (d) => d.toISOString().slice(0, 10);
    return { ok: true, location, days: n, ...summarizeInsights(rows, { from: iso(from), to: iso(to) }) };
  } catch (e) { return explainError(e); }
}

module.exports = { refreshGmbConnection, loadProfiles, loadInsights, explainError };
