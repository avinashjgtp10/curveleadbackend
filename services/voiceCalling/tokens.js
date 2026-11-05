// VoiceTokenService: issues provider client credentials. Provider API keys never leave the server.
const { query: defaultQuery } = require('../../config/db');
const { hasPermission: defaultHasPermission } = require('../../utils/permissions');
const { audit } = require('./audit');

function createTokenService(deps = {}) {
  const db = deps.query || defaultQuery;
  const hasPermission = deps.hasPermission || defaultHasPermission;
  const getProvider = deps.getProvider || require('./providers/factory').getVoiceProvider;
  return {
    async issue({ user, tenantId }) {
      const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
      if (!(await hasPermission(user, 'voice.call'))) throw fail(403, 'FORBIDDEN', 'You do not have permission to place calls.');
      const providerId = deps.providerId || process.env.VOICE_DEFAULT_PROVIDER || 'telnyx';
      const account = (await db('SELECT * FROM voice_accounts WHERE tenant_id=$1 AND provider=$2', [tenantId, providerId])).rows[0];
      if (!account || account.status !== 'active') throw fail(403, 'ACCOUNT_INACTIVE', 'Calling is not enabled for this organization.');
      const provider = getProvider(providerId);
      if (!provider.capabilities.clientToken) throw fail(501, 'UNSUPPORTED', 'Provider does not support client tokens.');
      const cred = (await db('SELECT provider_credential_id FROM voice_agent_credentials WHERE tenant_id=$1 AND user_id=$2 AND provider=$3', [tenantId, user.id, providerId])).rows[0];
      const out = await provider.createClientToken({ tenantId, userId: user.id, account, credentialId: cred?.provider_credential_id });
      if (!cred) {
        await db('INSERT INTO voice_agent_credentials (tenant_id, user_id, provider, provider_credential_id) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,user_id,provider) DO NOTHING',
          [tenantId, user.id, providerId, out.credentialId]);
      }
      await audit(db, { tenantId, actorId: user.id, action: 'token.issued', detail: { provider: providerId } });
      return { provider: providerId, token: out.token, expiresAt: out.expiresAt };
    },
  };
}
module.exports = { createTokenService };
