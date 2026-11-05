// Telnyx adapter. Only endpoints verified against developers.telnyx.com are used:
//   POST /v2/calls                                  dial (connection_id, to, from, client_state, command_id, time_limit_secs, webhook_url)
//   POST /v2/calls/{call_control_id}/actions/hangup hangup (command_id idempotency)
//   POST /v2/telephony_credentials                  create WebRTC credential (connection_id)
//   POST /v2/telephony_credentials/{id}/token       login JWT, plain-text body
//   Webhooks: Ed25519 over `${telnyx-timestamp}|${rawBody}`, headers telnyx-signature-ed25519 / telnyx-timestamp
// NOT implemented (endpoint not verified): getCallDetails. Cost reconciliation must use Telnyx detail
// records, to be added once verified against the account.
// Platform-level secrets come from process.env (populated from SSM by bootstrap.js), never the browser:
//   VOICE_TELNYX_API_KEY, VOICE_TELNYX_PUBLIC_KEY (base64 raw 32-byte Ed25519 key from Mission Control)
const crypto = require('crypto');
const axios = require('axios');
const { ProviderError } = require('./contract');

const BASE_URL = 'https://api.telnyx.com/v2';
const SIGNATURE_TOLERANCE_SECONDS = 300;
// Fixed DER prefix that wraps a raw 32-byte Ed25519 public key into SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const toDate = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

function createTelnyxProvider(deps = {}) {
  const http = deps.http || axios.create({ baseURL: BASE_URL, timeout: deps.timeoutMs || 10000 });
  const apiKey = () => deps.apiKey || process.env.VOICE_TELNYX_API_KEY;
  const publicKeyB64 = () => deps.publicKey || process.env.VOICE_TELNYX_PUBLIC_KEY;
  const now = deps.now || (() => Date.now());

  const call = async (method, url, data, config = {}) => {
    const key = apiKey();
    if (!key) throw new ProviderError('Telnyx API key is not configured.');
    try {
      return await http.request({ method, url, data, ...config, headers: { Authorization: `Bearer ${key}`, ...(config.headers || {}) } });
    } catch (e) {
      const status = e.response?.status ?? null;
      // Never include request headers/body (secrets, numbers) in the error.
      throw new ProviderError(`Telnyx ${method.toUpperCase()} ${url} failed${status ? ` (${status})` : `: ${e.code || 'network'}`}`,
        { status, retryable: !status || status >= 500 || status === 429 });
    }
  };

  return {
    id: 'telnyx',
    implemented: true,
    capabilities: { clientToken: true, serverDial: true, hangup: true, callDetails: false, webhookVerification: true },

    async createClientToken({ account, credentialId }) {
      const connectionId = account.provider_account_reference;
      if (!connectionId) throw new ProviderError('Voice account has no Telnyx connection id.');
      let id = credentialId;
      if (!id) {
        const created = await call('post', '/telephony_credentials', { connection_id: connectionId });
        id = created.data?.data?.id;
        if (!id) throw new ProviderError('Telnyx returned no credential id.');
      }
      const tok = await call('post', `/telephony_credentials/${encodeURIComponent(id)}/token`, undefined, { responseType: 'text' });
      const token = typeof tok.data === 'string' ? tok.data.trim() : null;
      if (!token) throw new ProviderError('Telnyx returned no token.');
      // API-minted tokens last 24h and cannot be revoked individually (delete the credential to revoke).
      return { token, credentialId: id, expiresAt: new Date(now() + 24 * 3600 * 1000) };
    },

    async initiateCall({ account, from, to, clientState, commandId, timeLimitSeconds, webhookUrl }) {
      const connectionId = account.provider_account_reference;
      if (!connectionId) throw new ProviderError('Voice account has no Telnyx connection id.');
      const body = {
        connection_id: connectionId, from, to,
        client_state: clientState, command_id: commandId,
        // Telnyx accepts 30..14400; the wallet-derived limit is the real cap, enforced again at settlement.
        time_limit_secs: Math.min(14400, Math.max(30, timeLimitSeconds)),
        ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      };
      const res = await call('post', '/calls', body);
      const d = res.data?.data;
      if (!d?.call_control_id) throw new ProviderError('Telnyx returned no call_control_id.');
      return { providerCallId: d.call_control_id, providerSessionId: d.call_session_id || null };
    },

    async hangupCall({ providerCallId, commandId }) {
      await call('post', `/calls/${encodeURIComponent(providerCallId)}/actions/hangup`, commandId ? { command_id: commandId } : {});
    },

    async getCallDetails() {
      throw new ProviderError('getCallDetails is not implemented for Telnyx (endpoint not verified).');
    },

    // Throws on any failure (fail closed). Returns a normalized event.
    verifyWebhook({ rawBody, headers }) {
      const key = publicKeyB64();
      if (!key) throw new ProviderError('Telnyx webhook public key is not configured.');
      const sig = headers['telnyx-signature-ed25519'];
      const ts = headers['telnyx-timestamp'];
      if (!sig || !ts) throw new ProviderError('Missing Telnyx signature headers.');
      const tsNum = Number(ts);
      if (!Number.isFinite(tsNum) || Math.abs(Math.floor(now() / 1000) - tsNum) > SIGNATURE_TOLERANCE_SECONDS) {
        throw new ProviderError('Telnyx webhook timestamp outside tolerance.');
      }
      const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
      let ok = false;
      try {
        const raw32 = Buffer.from(key, 'base64');
        if (raw32.length !== 32) throw new Error('bad key length');
        const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw32]), format: 'der', type: 'spki' });
        ok = crypto.verify(null, Buffer.concat([Buffer.from(`${ts}|`, 'utf8'), raw]), publicKey, Buffer.from(sig, 'base64'));
      } catch { ok = false; }
      if (!ok) throw new ProviderError('Invalid Telnyx webhook signature.');

      const body = JSON.parse(raw.toString('utf8'));
      const data = body.data || {};
      const p = data.payload || {};
      const rawType = data.event_type || 'unknown';
      const TYPE = { 'call.initiated': 'initiated', 'call.ringing': 'ringing', 'call.answered': 'answered', 'call.hangup': 'hangup' };
      if (!data.id) throw new ProviderError('Telnyx event has no id.');
      return {
        providerEventId: String(data.id),
        type: TYPE[rawType] || 'other',
        rawType,
        occurredAt: toDate(data.occurred_at),
        providerCallId: p.call_control_id || null,
        providerSessionId: p.call_session_id || null,
        clientState: p.client_state || null,
        detail: { startTime: toDate(p.start_time), endTime: toDate(p.end_time), hangupCause: p.hangup_cause || null },
        payload: body,
      };
    },
  };
}

module.exports = { createTelnyxProvider, SIGNATURE_TOLERANCE_SECONDS, ED25519_SPKI_PREFIX };
