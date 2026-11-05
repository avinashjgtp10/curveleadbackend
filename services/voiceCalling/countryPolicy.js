// VoiceCountryPolicyService. FAIL CLOSED: every check must positively pass; unknown/missing => deny.
// Pure evaluation (evaluateCallPolicy) is separate from loading so it is unit-testable.
const { query: defaultQuery } = require('../../config/db');

// ---- Platform hard limits (defense in depth: these apply even if a database policy row is wrong) -------------
// Only these destinations can ever be dialled, and only with their own calling code. Matches the Telnyx
// Outbound Voice Profile (India, Singapore, UAE). Override with VOICE_ALLOWED_DESTINATIONS="IN,SG,AE".
const CALLING_CODE = { IN: '+91', SG: '+65', AE: '+971' };
// The LEAD's local time zone, not the agent's and not the server's.
const DESTINATION_ZONE = { IN: 'Asia/Kolkata', SG: 'Asia/Singapore', AE: 'Asia/Dubai' };
// Hard ceiling on the calling window per destination (a database policy may only narrow it).
// UAE telemarketing: 09:00-18:00 local at most.
const MAX_WINDOW = { AE: ['09:00', '18:00'] };
const platformDestinations = (env = process.env) =>
  (env.VOICE_ALLOWED_DESTINATIONS || 'IN,SG,AE').split(',').map((c) => c.trim().toUpperCase()).filter((c) => CALLING_CODE[c]);
const platformAllows = (destination, env) =>
  !!destination && platformDestinations(env).includes(destination.country) && String(destination.e164).startsWith(CALLING_CODE[destination.country]);

// Minutes since local midnight in an IANA timezone.
const localMinutes = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  return h * 60 + Number(parts.find((p) => p.type === 'minute').value);
};
const timeToMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

/**
 * ctx: { originCountry, destination:{country,type,e164}, account, policy, callerId, hasActiveConsent, wantRecording, now }
 * returns { allowed:true, maxCallSeconds } | { allowed:false, code, message }
 */
const evaluateCallPolicy = (ctx) => {
  const deny = (code, message) => ({ allowed: false, code, message });
  const { account, policy, destination, callerId } = ctx;
  if (!account || account.status !== 'active') return deny('ACCOUNT_INACTIVE', 'Calling is not enabled for this organization.');
  if (!ctx.originCountry) return deny('ORG_COUNTRY_UNKNOWN', 'Organization country is not configured.');
  if (!destination) return deny('INVALID_NUMBER', 'The phone number is not a valid international number.');
  if (!platformAllows(destination, ctx.env)) return deny('ROUTE_DISABLED', `Calls to ${destination.country} are not enabled.`);
  if (!policy || policy.enabled !== true) return deny('ROUTE_DISABLED', `Calls to ${destination.country} are not enabled.`);
  if (!(account.allowed_destination_countries || []).includes(destination.country)) return deny('DESTINATION_NOT_ALLOWED', `${destination.country} is not approved for this organization.`);
  if (!(policy.allowed_number_types || []).includes(destination.type)) return deny('NUMBER_TYPE_BLOCKED', 'This type of number cannot be called.');
  if (policy.requires_business_verification && account.business_verification_status !== 'verified') return deny('BUSINESS_NOT_VERIFIED', 'Business verification is required.');
  if (policy.requires_verified_caller_id && (!callerId || callerId.verification_status !== 'verified')) return deny('NO_VERIFIED_CALLER_ID', 'No verified caller ID is available.');
  if (policy.requires_contact_consent && !ctx.hasActiveConsent) return deny('NO_CONSENT', 'No active contact consent is recorded for this lead.');
  if (ctx.wantRecording && !(policy.recording_allowed && account.recording_enabled)) return deny('RECORDING_NOT_PERMITTED', 'Recording is not permitted on this route.');
  try {
    const zone = DESTINATION_ZONE[destination.country] || policy.destination_timezone;
    const mins = localMinutes(ctx.now || new Date(), zone);
    let start = timeToMinutes(policy.calling_hours_start); let end = timeToMinutes(policy.calling_hours_end);
    if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(mins)) throw new Error('bad calling hours');
    const cap = MAX_WINDOW[destination.country];
    let inside;
    if (cap) { // a daytime ceiling: the policy can only narrow it, never wrap past midnight or widen it
      const capStart = timeToMinutes(cap[0]); const capEnd = timeToMinutes(cap[1]);
      const wraps = start > end;
      const s2 = wraps ? capStart : Math.max(start, capStart); const e2 = wraps ? capEnd : Math.min(end, capEnd);
      inside = s2 < e2 && mins >= s2 && mins < e2;
    } else {
      inside = start <= end ? mins >= start && mins < end : mins >= start || mins < end;
    }
    if (!inside) return deny('OUTSIDE_CALLING_HOURS', 'Outside permitted calling hours for the destination.');
  } catch { return deny('POLICY_INVALID', 'Calling-hours policy is invalid.'); }
  return { allowed: true, maxCallSeconds: Math.min(account.max_call_seconds, policy.max_call_seconds) };
};

function createCountryPolicyService(deps = {}) {
  const db = deps.query || defaultQuery;
  return {
    evaluateCallPolicy,
    async getPolicy(originCountry, destinationCountry) {
      return (await db('SELECT * FROM voice_country_policies WHERE origin_country=$1 AND destination_country=$2', [originCountry, destinationCountry])).rows[0] || null;
    },
    async hasActiveConsent(tenantId, leadId) {
      return (await db('SELECT 1 FROM voice_contact_consents WHERE tenant_id=$1 AND lead_id=$2 AND revoked_at IS NULL LIMIT 1', [tenantId, leadId])).rowCount > 0;
    },
    // Platform admin only (enforced by the route). Records who approved and why.
    async setRouteEnabled({ originCountry, destinationCountry, enabled, adminId, notes }) {
      if (enabled && !notes) throw Object.assign(new Error('Approval notes (provider + legal verification) are required.'), { status: 400 });
      const r = await db(
        `UPDATE voice_country_policies SET enabled=$3, approved_by=$4, approved_at=NOW(), approval_notes=$5, updated_at=NOW()
         WHERE origin_country=$1 AND destination_country=$2 RETURNING *`,
        [originCountry, destinationCountry, enabled, enabled ? adminId : null, notes || null]);
      return r.rows[0] || null;
    },
  };
}
module.exports = { evaluateCallPolicy, platformAllows, platformDestinations, MAX_WINDOW, DESTINATION_ZONE, createCountryPolicyService, localMinutes };
