const db = require('../../config/db');

// Facebook login health, shared by ad sync, posting and lead fetch.
// - Which ad permissions a login has (granted / declined by the person / never offered).
// - Graph error 190 = Facebook invalidated the login (password change, removed app,
//   security reset…). The connection is marked expired with the time and subcode, and
//   callers stop retrying: nothing can succeed until the person reconnects.

// The permissions shown after connecting Ads Manager.
const AD_PERMISSIONS = ['ads_read', 'ads_management', 'business_management', 'leads_retrieval'];

// Pure. `granted` = scopes from debug_token; `permissions` = /me/permissions rows
// ({ permission, status: 'granted' | 'declined' | 'expired' }). Anything not granted and
// not declined was never offered — for Standard Access permissions that means the person
// has no role on the Meta app.
const classifyPermissions = ({ granted = [], permissions = [] }, wanted = AD_PERMISSIONS) => {
  const statusOf = new Map(permissions.map(p => [p.permission, p.status]));
  const has = new Set([...granted, ...permissions.filter(p => p.status === 'granted').map(p => p.permission)]);
  const byName = Object.fromEntries(wanted.map(name => [name,
    has.has(name) ? 'granted' : statusOf.get(name) === 'declined' ? 'declined' : 'missing']));
  return {
    byName,
    granted: wanted.filter(n => byName[n] === 'granted'),
    declined: wanted.filter(n => byName[n] === 'declined'),
    missing: wanted.filter(n => byName[n] === 'missing'),
    allDeclined: permissions.filter(p => p.status === 'declined').map(p => p.permission),
  };
};

const MESSAGES = {
  ADS_READ_DECLINED: 'You turned off ad access during Facebook login. Click Reconnect and allow ad account access.',
  ADS_READ_NOT_APPROVED: 'Your Facebook account isn\'t approved for CurveLead ads access yet. Contact CurveLead support to be added as a tester, then click Connect again.',
};

// Pure: null when ad accounts can be read (ads_read or ads_management granted), else why not.
// Declined wins over missing: the person can fix that themselves by reconnecting.
const adsAccessProblem = (summary) => {
  const { byName } = summary;
  if (byName.ads_read === 'granted' || byName.ads_management === 'granted') return null;
  const code = byName.ads_read === 'declined' || byName.ads_management === 'declined' ? 'ADS_READ_DECLINED' : 'ADS_READ_NOT_APPROVED';
  return { code, message: MESSAGES[code] };
};

// Graph error 190 (any subcode), from MetaGraphError, an axios error or a debug_token error object.
const deadTokenInfo = (e) => {
  const err = e?.response?.data?.error || e;
  if (Number(err?.code) !== 190) return null;
  const subcode = err.subcode ?? err.error_subcode ?? null;
  return { code: 190, subcode: subcode == null ? null : Number(subcode), message: String(err.message || 'Facebook login is no longer valid.').slice(0, 500) };
};
const isDeadToken = (e) => !!deadTokenInfo(e);

const EXPIRED_TEXT = 'Facebook ended this login (password change, removed access or a security check). Reconnect Facebook.';

// Ads Manager / Social login row.
const expireAdToken = ({ tenantId, tokenId, info, query = db.query }) => query(
  `UPDATE ad_oauth_tokens SET status = 'expired', expired_at = COALESCE(expired_at, now()), error_subcode = $3, last_error = $4,
          last_checked_at = now(), updated_at = now()
   WHERE tenant_id = $1 AND id = $2`,
  [tenantId, tokenId, info?.subcode ?? null, info?.message || EXPIRED_TEXT]);

// A Page / Instagram account used for posting.
const expireSocialAccount = ({ tenantId, accountId, info, query = db.query }) => query(
  `UPDATE social_accounts SET status = 'expired', expired_at = COALESCE(expired_at, now()), error_subcode = $3, last_error = $4, updated_at = now()
   WHERE tenant_id = $1 AND id = $2`,
  [tenantId, accountId, info?.subcode ?? null, EXPIRED_TEXT]);

// The Page login used for lead ads (tenants.settings).
const expirePageToken = ({ tenantId, info, query = db.query }) => query(
  `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
     'meta_page_token_status', 'expired',
     'meta_page_token_expired_at', COALESCE(settings->>'meta_page_token_expired_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
     'meta_page_token_error_subcode', $2::int,
     'meta_page_token_error', $3::text)
   WHERE id = $1`,
  [tenantId, info?.subcode ?? null, info?.message || EXPIRED_TEXT]);

// Keys removed from tenants.settings when the Page is connected again.
const PAGE_TOKEN_HEALTH_KEYS = ['meta_page_token_status', 'meta_page_token_expired_at', 'meta_page_token_error_subcode', 'meta_page_token_error'];

module.exports = {
  AD_PERMISSIONS, MESSAGES, EXPIRED_TEXT, PAGE_TOKEN_HEALTH_KEYS,
  classifyPermissions, adsAccessProblem, deadTokenInfo, isDeadToken,
  expireAdToken, expireSocialAccount, expirePageToken,
};
