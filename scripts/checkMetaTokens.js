// One-off: checks every saved Facebook login with Meta's debug_token and marks the ones
// Facebook has ended as expired (same as the jobs do on Graph error 190). Three kinds:
//   ads    — Ads Manager / Social logins (ad_oauth_tokens)
//   social — Facebook Page / Instagram accounts used for posting (social_accounts)
//   page   — the Page login used for lead ads (tenants.settings.meta_page_access_token)
// Nothing is deleted. Tokens are never printed.
//
// Usage: node scripts/checkMetaTokens.js            (dry run — reports only)
//        node scripts/checkMetaTokens.js --apply    (marks invalid logins expired)
const { inspectToken } = require('../services/metaAds/client');
const { decryptToken } = require('../utils/cryptoSecrets');
const { expireAdToken, expireSocialAccount, expirePageToken } = require('../services/metaAds/tokenHealth');

// Pure: what to do with one debug_token result.
const verdict = (info) => {
  if (info.check_failed) return { valid: null, action: 'check failed — left as is' };
  if (info.is_valid) return { valid: true, action: 'ok' };
  return { valid: false, action: 'mark expired', subcode: info.error?.subcode ?? null, reason: info.error?.message || 'Meta reports the login is no longer valid.' };
};

async function run(db, { apply = false, inspect = inspectToken, log = console.log } = {}) {
  const items = [];
  const ads = await db.query(
    `SELECT o.id, o.tenant_id, t.name AS workspace, o.status, o.token_encrypted, o.key_version
     FROM ad_oauth_tokens o JOIN tenants t ON t.id = o.tenant_id
     WHERE o.provider = 'meta' AND o.status <> 'expired' ORDER BY t.name`);
  for (const r of ads.rows) items.push({ kind: 'ads', id: r.id, tenantId: r.tenant_id, workspace: r.workspace, name: 'Facebook login (Ads/Social)', status: r.status, enc: r.token_encrypted, kv: r.key_version });
  const social = await db.query(
    `SELECT a.id, a.tenant_id, t.name AS workspace, a.platform, a.name, a.status, a.token_encrypted, a.key_version
     FROM social_accounts a JOIN tenants t ON t.id = a.tenant_id
     WHERE a.platform IN ('facebook', 'instagram') AND a.token_encrypted IS NOT NULL AND a.status <> 'expired' ORDER BY t.name, a.name`);
  for (const r of social.rows) items.push({ kind: 'social', id: r.id, tenantId: r.tenant_id, workspace: r.workspace, name: `${r.platform}: ${r.name || r.id}`, status: r.status, enc: r.token_encrypted, kv: r.key_version });
  const pages = await db.query(
    `SELECT id, name AS workspace, settings->>'meta_page_name' AS page, settings->>'meta_page_access_token' AS token
     FROM tenants WHERE COALESCE(settings->>'meta_page_access_token', '') <> '' AND COALESCE(settings->>'meta_page_token_status', '') <> 'expired' ORDER BY name`);
  for (const r of pages.rows) items.push({ kind: 'page', id: r.id, tenantId: r.id, workspace: r.workspace, name: `Page login (lead ads): ${r.page || '—'}`, status: 'active', plain: r.token });

  const results = [];
  for (const it of items) {
    let info;
    try {
      const token = it.plain || decryptToken(it.enc, it.kv);
      info = await inspect(token);
    } catch (e) { info = { check_failed: true, error: { message: e.message } }; }
    const v = verdict(info);
    if (apply && v.valid === false) {
      const dead = { subcode: v.subcode, message: v.reason };
      if (it.kind === 'ads') await expireAdToken({ tenantId: it.tenantId, tokenId: it.id, info: dead, query: db.query });
      else if (it.kind === 'social') await expireSocialAccount({ tenantId: it.tenantId, accountId: it.id, info: dead, query: db.query });
      else await expirePageToken({ tenantId: it.tenantId, info: dead, query: db.query });
    }
    const row = { kind: it.kind, workspace: it.workspace, connection: it.name, status: it.status, valid: v.valid,
      ...(v.subcode != null ? { subcode: v.subcode } : {}), ...(v.reason ? { reason: v.reason } : {}),
      ...(info.check_failed ? { error: info.error.message } : {}),
      action: v.valid === false ? (apply ? 'marked expired' : 'would mark expired') : v.action };
    results.push(row);
    log(JSON.stringify(row));
  }
  const summary = { checked: results.length, valid: results.filter(r => r.valid === true).length, invalid: results.filter(r => r.valid === false).length,
    check_failed: results.filter(r => r.valid === null).length, mode: apply ? 'apply' : 'dry-run' };
  log(JSON.stringify(summary));
  return { results, summary };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--apply' && a !== '--dry-run')) { console.error('Usage: node scripts/checkMetaTokens.js [--dry-run|--apply]'); process.exitCode = 1; }
  else {
    const db = require('../config/db');
    run(db, { apply: args.includes('--apply') }).catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => db.pool.end());
  }
}
module.exports = { run, verdict };
