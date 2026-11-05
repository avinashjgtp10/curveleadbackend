// VoiceCountryPolicyService. FAIL CLOSED: every check must positively pass; unknown/missing => deny.
// Pure evaluation (evaluateCallPolicy) is separate from loading so it is unit-testable.
const { query: defaultQuery } = require('../../config/db');

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
  if (!policy || policy.enabled !== true) return deny('ROUTE_DISABLED', `Calls to ${destination.country} are not enabled.`);
  if (!(account.allowed_destination_countries || []).includes(destination.country)) return deny('DESTINATION_NOT_ALLOWED', `${destination.country} is not approved for this organization.`);
  if (!(policy.allowed_number_types || []).includes(destination.type)) return deny('NUMBER_TYPE_BLOCKED', 'This type of number cannot be called.');
  if (policy.requires_business_verification && account.business_verification_status !== 'verified') return deny('BUSINESS_NOT_VERIFIED', 'Business verification is required.');
  if (policy.requires_verified_caller_id && (!callerId || callerId.verification_status !== 'verified')) return deny('NO_VERIFIED_CALLER_ID', 'No verified caller ID is available.');
  if (policy.requires_contact_consent && !ctx.hasActiveConsent) return deny('NO_CONSENT', 'No active contact consent is recorded for this lead.');
  if (ctx.wantRecording && !(policy.recording_allowed && account.recording_enabled)) return deny('RECORDING_NOT_PERMITTED', 'Recording is not permitted on this route.');
  try {
    const mins = localMinutes(ctx.now || new Date(), policy.destination_timezone);
    const start = timeToMinutes(policy.calling_hours_start); const end = timeToMinutes(policy.calling_hours_end);
    const inside = start <= end ? mins >= start && mins < end : mins >= start || mins < end;
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
module.exports = { evaluateCallPolicy, createCountryPolicyService, localMinutes };
