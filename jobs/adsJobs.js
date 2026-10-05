const { query } = require('../config/db');
const queues = require('./queues');
const { syncAdAccount } = require('../services/metaAds/sync');
const { syncGoogleAccount } = require('../services/googleAds/sync');
const { inspectToken, exchangeForLongLived, saveToken } = require('../services/metaAds/client');
const { decryptToken } = require('../utils/cryptoSecrets');
const { expireAdToken } = require('../services/metaAds/tokenHealth');
const { createNotification } = require('../controllers/notificationController');

const SYNC_EVERY_MS = Number(process.env.ADS_INSIGHTS_SYNC_MINUTES || 240) * 60 * 1000;
const TOKEN_REFRESH_WINDOW_MS = 10 * 864e5;

// Fans out one sync job per active Meta / Google Ads account with a usable token.
const syncAll = async () => {
  const { rows } = await query(
    `SELECT a.tenant_id, a.id FROM ad_accounts a
     JOIN ad_oauth_tokens t ON t.id = a.token_id AND t.tenant_id = a.tenant_id AND t.status = 'active'
     JOIN tenants tn ON tn.id = a.tenant_id AND tn.subscription_status IN ('active','trial')
     WHERE a.is_active`
  );
  for (const r of rows) await queues.enqueue('ads:sync-account', { tenantId: r.tenant_id, adAccountId: r.id }, { jobId: `sync-${r.id}` });
  return rows.length;
};

const notifyAdmins = async (tenantId, title) => {
  const { rows } = await query("SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND is_active = true", [tenantId]);
  for (const u of rows) await createNotification(tenantId, u.id, title, title, 'integration_health', 'integration', null).catch(() => {});
};

// Daily: re-checks every Meta token. Long-lived user tokens close to expiry are
// exchanged for a fresh one (Meta extends them when possible); invalid or expired
// tokens are marked and the workspace admins are told to reconnect.
const refreshTokens = async () => {
  const { rows } = await query("SELECT id, tenant_id, token_encrypted, key_version, expires_at FROM ad_oauth_tokens WHERE provider = 'meta' AND status = 'active'");
  for (const t of rows) {
    try {
      const token = decryptToken(t.token_encrypted, t.key_version);
      const info = await inspectToken(token);
      if (!info.is_valid) {
        await expireAdToken({ tenantId: t.tenant_id, tokenId: t.id, info: { subcode: info.error?.subcode ?? null, message: info.error?.message || 'Meta reports the token is no longer valid.' } });
        await notifyAdmins(t.tenant_id, 'Facebook Ads disconnected — reconnect to keep ad data syncing.');
        continue;
      }
      let expiresAt = info.expires_at;
      if (expiresAt && expiresAt.getTime() - Date.now() < TOKEN_REFRESH_WINDOW_MS) {
        const fresh = await exchangeForLongLived(token).catch(() => null);
        const freshInfo = fresh ? await inspectToken(fresh).catch(() => null) : null;
        if (freshInfo?.is_valid && (!freshInfo.expires_at || freshInfo.expires_at > expiresAt)) {
          await saveToken({ tenantId: t.tenant_id, externalUserId: freshInfo.user_id || info.user_id, token: fresh, scopes: freshInfo.scopes, expiresAt: freshInfo.expires_at });
          continue;
        }
        await notifyAdmins(t.tenant_id, `Facebook Ads access expires on ${expiresAt.toDateString()} — reconnect Facebook to keep ad data syncing.`);
      }
      await query('UPDATE ad_oauth_tokens SET expires_at = $3, scopes = $4, last_checked_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2',
        [t.tenant_id, t.id, expiresAt, info.scopes]);
    } catch (e) {
      console.error('[ads] token check failed', t.id, e.message);
    }
  }
};

// One job name for both providers, so "Sync now" and the 4-hourly fan-out work the same.
const syncAccount = async (data) => {
  const { rows } = await query('SELECT provider FROM ad_accounts WHERE tenant_id = $1 AND id = $2', [data.tenantId, data.adAccountId]);
  if (!rows[0]) return { skipped: 'not_found' };
  return rows[0].provider === 'google' ? syncGoogleAccount(data) : syncAdAccount(data);
};

const registerAdsJobs = () => {
  queues.register('ads:sync-all', () => syncAll(), { attempts: 1 });
  queues.register('ads:sync-account', (data) => syncAccount(data), { attempts: 5, backoffMs: 30000, concurrency: 2 });
  queues.register('ads:refresh-tokens', () => refreshTokens(), { attempts: 3, backoffMs: 60000 });
  queues.repeat('ads:sync-all', SYNC_EVERY_MS, {}, 90 * 1000);
  queues.repeat('ads:refresh-tokens', 24 * 60 * 60 * 1000, {}, 5 * 60 * 1000);
};

module.exports = { registerAdsJobs, syncAll, syncAccount, refreshTokens };
