const { query } = require('../../config/db');
const { encryptToken, decryptToken } = require('../../utils/cryptoSecrets');
const gads = require('../../utils/googleAds');

// Google Ads logins and accounts. The refresh token is stored encrypted in
// ad_oauth_tokens (provider 'google'); accounts go to ad_accounts (provider 'google').
// Every query is tenant-scoped.

// Google status → the integer ad_accounts.account_status already used for Meta (1 = active).
const STATUS_CODE = { ENABLED: 1, SUSPENDED: 2, CANCELED: 101, CLOSED: 101 };

const saveGoogleToken = async ({ tenantId, userId, externalUserId, refreshToken, scopes }) => {
  const { ciphertext, keyVersion } = encryptToken(refreshToken);
  const { rows } = await query(
    `INSERT INTO ad_oauth_tokens (tenant_id, provider, external_user_id, token_encrypted, key_version, scopes, expires_at, status, last_checked_at, last_refreshed_at, created_by)
     VALUES ($1, 'google', $2, $3, $4, $5, NULL, 'active', now(), now(), $6)
     ON CONFLICT (tenant_id, provider, external_user_id) DO UPDATE SET
       token_encrypted = EXCLUDED.token_encrypted, key_version = EXCLUDED.key_version, scopes = EXCLUDED.scopes,
       status = 'active', last_error = NULL, last_checked_at = now(), last_refreshed_at = now(), updated_at = now()
     RETURNING id`,
    [tenantId, externalUserId, ciphertext, keyVersion, scopes || [], userId || null]);
  return rows[0].id;
};

// Pure: the accounts a login can use, from the customers it can reach directly and the
// client accounts under any manager (MCC) among them. Direct access wins over
// access through a manager; managers themselves aren't advertising accounts.
const accountsFromCustomers = ({ direct, children }) => {
  const out = new Map();
  for (const c of direct) if (!c.manager) out.set(c.id, { ...c, login_customer_id: null });
  for (const [managerId, list] of Object.entries(children)) {
    for (const c of list) if (!c.manager && !out.has(c.id)) out.set(c.id, { ...c, login_customer_id: managerId });
  }
  return [...out.values()];
};

const customerFields = (prefix, r) => {
  const c = r[prefix] || {};
  return { id: gads.digits(c.id), name: c.descriptiveName || null, currency: c.currencyCode || null, timezone: c.timeZone || null, manager: !!c.manager, status: c.status || null };
};

// Lists and saves every Google Ads account a login can use. deps for tests.
const discoverGoogleAccounts = async ({ tenantId, tokenId, accessToken, deps = {} }) => {
  const search = deps.search || gads.search;
  const list = deps.listAccessibleCustomers || gads.listAccessibleCustomers;
  const db = deps.query || query;
  const ids = await list({ accessToken });
  const direct = [], children = {}, skipped = [];
  for (const id of ids) {
    try {
      const [row] = await search({ customerId: id, accessToken, gaql:
        'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1' });
      if (!row) continue;
      const c = customerFields('customer', row);
      direct.push(c);
      if (c.manager) {
        children[c.id] = (await search({ customerId: id, accessToken, loginCustomerId: id, gaql:
          `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone,
                  customer_client.manager, customer_client.status, customer_client.level
           FROM customer_client WHERE customer_client.level <= 1 AND customer_client.manager = false` }))
          .map(r => customerFields('customerClient', r));
      }
    } catch (e) {
      if (e.name === 'GoogleAdsError' && !e.retryable && e.code !== 'DEVELOPER_TOKEN_NOT_APPROVED') { skipped.push({ id, reason: e.message }); continue; }
      throw e;
    }
  }
  const accounts = accountsFromCustomers({ direct, children });
  for (const a of accounts) {
    await db(
      `INSERT INTO ad_accounts (tenant_id, provider, external_id, name, currency, timezone_name, account_status, token_id, login_customer_id, is_primary)
       VALUES ($1, 'google', $2, $3, $4, $5, $6, $7, $8,
               NOT EXISTS (SELECT 1 FROM ad_accounts WHERE tenant_id = $1 AND provider = 'google' AND is_primary))
       ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET
         name = EXCLUDED.name, currency = EXCLUDED.currency, timezone_name = EXCLUDED.timezone_name, account_status = EXCLUDED.account_status,
         token_id = EXCLUDED.token_id, login_customer_id = EXCLUDED.login_customer_id, updated_at = now()`,
      [tenantId, a.id, a.name, a.currency, a.timezone, STATUS_CODE[a.status] ?? null, tokenId, a.login_customer_id]);
  }
  return { accounts: accounts.length, skipped };
};

// Account row + a fresh access token, scoped to the tenant.
const getGoogleAccountWithToken = async (tenantId, adAccountId) => {
  const { rows } = await query(
    `SELECT a.*, t.token_encrypted, t.key_version, t.status AS token_status, t.id AS token_row_id
     FROM ad_accounts a LEFT JOIN ad_oauth_tokens t ON t.id = a.token_id AND t.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.id = $2 AND a.provider = 'google'`, [tenantId, adAccountId]);
  const account = rows[0];
  if (!account) return null;
  const refreshToken = account.token_encrypted ? decryptToken(account.token_encrypted, account.key_version) : null;
  return { account, refreshToken };
};

module.exports = { saveGoogleToken, discoverGoogleAccounts, accountsFromCustomers, getGoogleAccountWithToken, STATUS_CODE };
