// Platform-level config check for CurveLead Voice. Pure: reads an env object, never logs or returns values.
// Per-organization settings (Telnyx connection ID, caller ID numbers) live in the database and are validated
// when a super admin saves them (services/voiceCalling/admin.js), not here.
const KEY_PREFIX = 'KEY';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const validateVoiceConfig = (env = process.env) => {
  const provider = env.VOICE_DEFAULT_PROVIDER || 'telnyx';
  const apiKey = (env.VOICE_TELNYX_API_KEY || '').trim();
  const publicKey = (env.VOICE_TELNYX_PUBLIC_KEY || '').trim();
  const errors = [];

  if (provider !== 'telnyx') {
    return { provider, configured: false, ok: false, errors: [`VOICE_DEFAULT_PROVIDER "${provider}" is not an implemented provider (use "telnyx").`] };
  }
  // Nothing set at all = voice was never turned on for this environment. Not an error, just disabled.
  if (!apiKey && !publicKey) return { provider, configured: false, ok: false, errors: [] };

  if (!apiKey) errors.push('VOICE_TELNYX_API_KEY is missing.');
  else if (!apiKey.startsWith(KEY_PREFIX)) errors.push(`VOICE_TELNYX_API_KEY must start with "${KEY_PREFIX}" (a Telnyx v2 API key).`);

  if (!publicKey) errors.push('VOICE_TELNYX_PUBLIC_KEY is missing.');
  else if (!BASE64.test(publicKey) || publicKey.length % 4 !== 0 || Buffer.from(publicKey, 'base64').length !== 32) {
    errors.push('VOICE_TELNYX_PUBLIC_KEY must be a base64-encoded raw 32-byte Ed25519 public key.');
  }
  return { provider, configured: true, ok: errors.length === 0, errors };
};

// Logs once at boot. Never throws: calling is optional and must not stop the API from starting.
const logVoiceConfig = (env = process.env, log = console) => {
  const r = validateVoiceConfig(env);
  if (r.ok) log.log('[voice] Telnyx configuration looks valid; calling is available to organizations that are set up.');
  else if (r.errors.length) { r.errors.forEach((e) => log.error(`[voice] ${e}`)); log.error('[voice] Voice stays DISABLED until this is fixed.'); }
  else log.log('[voice] Telnyx keys are not set; voice calling is disabled.');
  return r;
};

const E164 = /^\+[1-9]\d{6,14}$/;
// Whether the Call button should be offered. Informational only: authorize() re-checks everything.
// Needs valid platform keys, an active org account WITH its Telnyx connection id, a verified E.164 caller ID,
// and the user's voice.call permission.
const computeVoiceEnabled = ({ config, account, callerIds = [], canCall }) =>
  !!(config?.ok && canCall && account && account.status === 'active'
    && String(account.provider_account_reference || '').trim()
    && callerIds.some((n) => n.verification_status === 'verified' && E164.test(n.phone_number_e164 || '')));

const voiceUnavailable = () => Object.assign(new Error('Calling is not available right now.'), { status: 503, code: 'VOICE_UNAVAILABLE' });

module.exports = { computeVoiceEnabled, validateVoiceConfig, logVoiceConfig, voiceUnavailable };
