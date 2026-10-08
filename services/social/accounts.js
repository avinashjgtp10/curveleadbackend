const { query } = require('../../config/db');
const { encryptToken, decryptToken } = require('../../utils/cryptoSecrets');
const { graphPaged } = require('../../utils/metaGraph');
const { accessTokenFor, listLocations } = require('./gbp');

// Where a workspace can post. Facebook Pages (and the Instagram professional accounts
// linked to them) come from a Facebook login stored in ad_oauth_tokens; Google Business
// Profile locations come from the workspace's Google connection. Every query is tenant-scoped.

// Facebook permissions each platform needs to publish.
const REQUIRED_SCOPES = { facebook: ['pages_manage_posts'], instagram: ['instagram_content_publish'] };
const missingScopes = (platform, scopes = []) => (REQUIRED_SCOPES[platform] || []).filter(s => !scopes.includes(s));

const upsertAccount = (tenantId, a) => query(
  `INSERT INTO social_accounts (tenant_id, platform, external_id, parent_external_id, name, username, picture_url, token_id, token_encrypted, key_version, status, last_error, meta)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', NULL, $11)
   ON CONFLICT (tenant_id, platform, external_id) DO UPDATE SET
     parent_external_id = EXCLUDED.parent_external_id, name = EXCLUDED.name, username = EXCLUDED.username,
     picture_url = EXCLUDED.picture_url, token_id = COALESCE(EXCLUDED.token_id, social_accounts.token_id),
     token_encrypted = COALESCE(EXCLUDED.token_encrypted, social_accounts.token_encrypted),
     key_version = COALESCE(EXCLUDED.key_version, social_accounts.key_version),
     status = 'active', last_error = NULL, expired_at = NULL, error_subcode = NULL, meta = EXCLUDED.meta, updated_at = now()
   RETURNING id`,
  [tenantId, a.platform, a.external_id, a.parent_external_id || null, a.name || null, a.username || null, a.picture_url || null,
    a.token_id || null, a.token_encrypted || null, a.key_version || null, JSON.stringify(a.meta || {})]
);

// Pages a Facebook user token manages → facebook + instagram rows (Page token, encrypted).
// Long-lived user tokens give Page tokens that don't expire.
const discoverMetaAccounts = async ({ tenantId, tokenId, token, scopes = [] }) => {
  const pages = await graphPaged({ path: '/me/accounts', token,
    params: { fields: 'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,profile_picture_url}', limit: 100 } });
  let facebook = 0, instagram = 0;
  for (const p of pages) {
    if (!p.access_token) continue;
    const { ciphertext, keyVersion } = encryptToken(p.access_token);
    const canCreate = !Array.isArray(p.tasks) || p.tasks.includes('CREATE_CONTENT') || p.tasks.includes('MANAGE');
    await upsertAccount(tenantId, {
      platform: 'facebook', external_id: String(p.id), name: p.name, picture_url: p.picture?.data?.url,
      token_id: tokenId, token_encrypted: ciphertext, key_version: keyVersion,
      meta: { missing_scopes: missingScopes('facebook', scopes), can_create_content: canCreate },
    });
    facebook++;
    const ig = p.instagram_business_account;
    if (ig?.id) {
      await upsertAccount(tenantId, {
        platform: 'instagram', external_id: String(ig.id), parent_external_id: String(p.id), name: ig.username || p.name,
        username: ig.username, picture_url: ig.profile_picture_url, token_id: tokenId, token_encrypted: ciphertext, key_version: keyVersion,
        meta: { missing_scopes: missingScopes('instagram', scopes), page_name: p.name },
      });
      instagram++;
    }
  }
  return { facebook, instagram };
};

// Re-reads Pages/Instagram from every Facebook login the workspace already connected
// (Ads Manager), so nobody has to log in again.
const refreshMetaAccounts = async (tenantId) => {
  const { rows } = await query(
    "SELECT id, token_encrypted, key_version, scopes FROM ad_oauth_tokens WHERE tenant_id = $1 AND provider = 'meta' AND status = 'active'", [tenantId]);
  const total = { facebook: 0, instagram: 0, errors: [] };
  for (const t of rows) {
    try {
      const r = await discoverMetaAccounts({ tenantId, tokenId: t.id, token: decryptToken(t.token_encrypted, t.key_version), scopes: t.scopes || [] });
      total.facebook += r.facebook; total.instagram += r.instagram;
    } catch (e) { total.errors.push(e.message); }
  }
  return total;
};

// GBP locations from the Google connection.
const discoverGbpAccounts = async (tenantId) => {
  const settings = (await query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]?.settings || {};
  const locations = await listLocations({ accessToken: await accessTokenFor(settings) });
  for (const l of locations) {
    await upsertAccount(tenantId, { platform: 'gbp', external_id: l.external_id, parent_external_id: l.parent_external_id, name: l.name, meta: { address: l.address } });
  }
  return { gbp: locations.length };
};

const listAccounts = async (tenantId) => (await query(
  `SELECT id, platform, external_id, parent_external_id, name, username, picture_url, status, last_error, is_active, meta, updated_at
   FROM social_accounts WHERE tenant_id = $1 ORDER BY platform, name`, [tenantId])).rows;

// Account + decrypted token for publishing.
const getAccountForPublish = async (tenantId, accountId) => {
  const a = (await query('SELECT * FROM social_accounts WHERE tenant_id = $1 AND id = $2', [tenantId, accountId])).rows[0];
  if (!a) return null;
  return { ...a, token: a.token_encrypted ? decryptToken(a.token_encrypted, a.key_version) : null };
};

const markAccount = (tenantId, accountId, status, error) => query(
  'UPDATE social_accounts SET status = $3, last_error = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2',
  [tenantId, accountId, status, error ? String(error).slice(0, 500) : null]);

module.exports = { REQUIRED_SCOPES, missingScopes, discoverMetaAccounts, refreshMetaAccounts, discoverGbpAccounts, listAccounts, getAccountForPublish, markAccount, upsertAccount };
