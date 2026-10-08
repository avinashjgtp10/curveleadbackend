// One-off: moves each workspace's legacy plaintext Meta Ads token
// (tenants.settings.meta_ads_access_token) into the encrypted ad_oauth_tokens
// table, lists its ad accounts into ad_accounts, and makes the account already
// selected in Integrations (settings.meta_ad_account_id) the primary one.
// The legacy settings value is left in place for code that still reads it.
//
// Usage: node scripts/migrateAdTokens.js --dry-run|--apply
const { inspectToken, saveToken, syncAccountsForToken } = require('../services/metaAds/client');

const normaliseAccountId = (id) => (id ? (String(id).startsWith('act_') ? String(id) : `act_${id}`) : null);

async function run(db, apply = false) {
  const { rows } = await db.query(
    `SELECT id, name, settings->>'meta_ads_access_token' AS token, settings->>'meta_ad_account_id' AS account_id
     FROM tenants WHERE COALESCE(settings->>'meta_ads_access_token', '') <> ''`
  );
  let migrated = 0, invalid = 0;
  for (const t of rows) {
    const info = await inspectToken(t.token).catch((e) => ({ is_valid: false, error: e.message }));
    if (!info.is_valid || !info.user_id) {
      invalid++;
      console.log(JSON.stringify({ tenant_id: t.id, tenant: t.name, status: 'invalid_token', error: info.error || null }));
      continue;
    }
    const primary = normaliseAccountId(t.account_id);
    console.log(JSON.stringify({ tenant_id: t.id, tenant: t.name, status: apply ? 'migrating' : 'would_migrate', primary_account: primary, expires_at: info.expires_at, scopes: info.scopes }));
    if (!apply) continue;
    const tokenId = await saveToken({ tenantId: t.id, externalUserId: info.user_id, token: t.token, scopes: info.scopes, expiresAt: info.expires_at });
    const accounts = await syncAccountsForToken({ tenantId: t.id, tokenId, token: t.token });
    if (primary) {
      await db.query(
        `UPDATE ad_accounts SET is_primary = (external_id = $2), updated_at = now()
         WHERE tenant_id = $1 AND provider = 'meta' AND EXISTS (SELECT 1 FROM ad_accounts WHERE tenant_id = $1 AND external_id = $2)`,
        [t.id, primary]
      );
    }
    migrated++;
    console.log(JSON.stringify({ tenant_id: t.id, status: 'migrated', ad_accounts: accounts }));
  }
  console.log(JSON.stringify({ tenants: rows.length, migrated, invalid, apply }));
  return { migrated, invalid };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--dry-run', '--apply'].includes(args[0])) { console.error('Usage: node scripts/migrateAdTokens.js --dry-run|--apply'); process.exitCode = 1; }
  else {
    const db = require('../config/db');
    run(db, args[0] === '--apply').catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.pool.end());
  }
}
module.exports = { run, normaliseAccountId };
