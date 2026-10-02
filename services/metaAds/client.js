const { query } = require('../../config/db');
const { encryptToken, decryptToken } = require('../../utils/cryptoSecrets');
const { graphRequest, graphPaged } = require('../../utils/metaGraph');

// Token storage and lookup for the Ads module. Every query is tenant-scoped.

const appToken = () => {
  const { META_APP_ID, META_APP_SECRET } = process.env;
  if (!META_APP_ID || !META_APP_SECRET) throw new Error('META_APP_ID / META_APP_SECRET not configured on server.');
  return `${META_APP_ID}|${META_APP_SECRET}`;
};

// Short-lived user token (from FB Login) → long-lived (~60 days).
const exchangeForLongLived = async (shortToken) => {
  const { META_APP_ID, META_APP_SECRET } = process.env;
  const data = await graphRequest({
    path: '/oauth/access_token', token: appToken(), retries: 2,
    params: { grant_type: 'fb_exchange_token', client_id: META_APP_ID, client_secret: META_APP_SECRET, fb_exchange_token: shortToken },
  });
  return data.access_token;
};

// { is_valid, user_id, scopes, expires_at (Date|null — null = never) }
const inspectToken = async (token) => {
  const { data } = await graphRequest({ path: '/debug_token', token: appToken(), params: { input_token: token }, retries: 2 });
  const expires = Number(data?.expires_at) || Number(data?.data_access_expires_at) || 0;
  return {
    is_valid: !!data?.is_valid,
    user_id: data?.user_id ? String(data.user_id) : null,
    scopes: data?.scopes || [],
    expires_at: Number(data?.expires_at) === 0 ? null : expires ? new Date(expires * 1000) : null,
  };
};

const saveToken = async ({ tenantId, userId, externalUserId, token, scopes, expiresAt }) => {
  const { ciphertext, keyVersion } = encryptToken(token);
  const { rows } = await query(
    `INSERT INTO ad_oauth_tokens (tenant_id, provider, external_user_id, token_encrypted, key_version, scopes, expires_at, status, last_checked_at, last_refreshed_at, created_by)
     VALUES ($1, 'meta', $2, $3, $4, $5, $6, 'active', now(), now(), $7)
     ON CONFLICT (tenant_id, provider, external_user_id) DO UPDATE SET
       token_encrypted = EXCLUDED.token_encrypted, key_version = EXCLUDED.key_version, scopes = EXCLUDED.scopes,
       expires_at = EXCLUDED.expires_at, status = 'active', last_error = NULL,
       last_checked_at = now(), last_refreshed_at = now(), updated_at = now()
     RETURNING id`,
    [tenantId, externalUserId, ciphertext, keyVersion, scopes || [], expiresAt || null, userId || null]
  );
  return rows[0].id;
};

const markToken = (tenantId, tokenId, status, error) => query(
  'UPDATE ad_oauth_tokens SET status = $3, last_error = $4, last_checked_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2',
  [tenantId, tokenId, status, error ? String(error).slice(0, 500) : null]
);

// Lists the ad accounts a token can see and upserts them for the tenant.
// The first account becomes primary if the tenant has none yet.
const syncAccountsForToken = async ({ tenantId, tokenId, token }) => {
  const accounts = await graphPaged({ path: '/me/adaccounts', token, params: { fields: 'id,name,currency,timezone_name,account_status', limit: 100 } });
  for (const a of accounts) {
    await query(
      `INSERT INTO ad_accounts (tenant_id, provider, external_id, name, currency, timezone_name, account_status, token_id, is_primary)
       VALUES ($1, 'meta', $2, $3, $4, $5, $6, $7,
               NOT EXISTS (SELECT 1 FROM ad_accounts WHERE tenant_id = $1 AND provider = 'meta' AND is_primary))
       ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET
         name = EXCLUDED.name, currency = EXCLUDED.currency, timezone_name = EXCLUDED.timezone_name,
         account_status = EXCLUDED.account_status, token_id = EXCLUDED.token_id, updated_at = now()`,
      [tenantId, a.id, a.name || null, a.currency || null, a.timezone_name || null, a.account_status ?? null, tokenId]
    );
  }
  return accounts.length;
};

// Ad account row + decrypted token, scoped to the tenant.
const getAccountWithToken = async (tenantId, adAccountId) => {
  const { rows } = await query(
    `SELECT a.*, t.token_encrypted, t.key_version, t.status AS token_status, t.id AS token_row_id
     FROM ad_accounts a LEFT JOIN ad_oauth_tokens t ON t.id = a.token_id AND t.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, adAccountId]
  );
  const account = rows[0];
  if (!account) return null;
  const token = account.token_encrypted ? decryptToken(account.token_encrypted, account.key_version) : null;
  delete account.token_encrypted;
  return { account, token };
};

module.exports = { appToken, exchangeForLongLived, inspectToken, saveToken, markToken, syncAccountsForToken, getAccountWithToken };
