const { query } = require('../../config/db');
const queues = require('../../jobs/queues');
const { getAccountForPublish, markAccount } = require('./accounts');
const { signedUrl } = require('./media');
const { platformErrors } = require('./rules');
const { publishToFacebook } = require('./facebook');
const { publishToInstagram } = require('./instagram');
const { publishToGbp, accessTokenFor } = require('./gbp');

// Publishing a post = one attempt per target account. Each target succeeds or fails on
// its own; temporary failures (throttling, Meta/Google outages, a video still
// processing) are retried up to MAX_ATTEMPTS with backoff; permanent ones (expired
// login, missing permission, rejected media) are not.
//
// A post is claimed atomically (status scheduled → publishing) before anything is sent,
// so the delayed job, the 1-minute sweep and "Post now" can never publish it twice.

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2 * 60 * 1000;
const STUCK_AFTER_MIN = 30;

const retryDelayMs = (attempts) => RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);   // 2, 4 min

// Is this error worth retrying later?
const isRetryable = (e) => {
  if (e?.retryable) return true;
  if (e?.name === 'MetaGraphError') return e.isTransient && !e.isAuth;
  return !e?.status && !e?.response && /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timeout/i.test(e?.message || '');
};
const isAuthError = (e) => (e?.name === 'MetaGraphError' && (e.isAuth || e.code === 200 || e.code === 10)) || e?.status === 401;

const friendlyError = (platform, e) => {
  if (e?.name === 'MetaGraphError' && e.isAuth) return 'The Facebook login for this account expired — reconnect in Social → Accounts.';
  if (e?.name === 'MetaGraphError' && (e.code === 200 || e.code === 10)) {
    return platform === 'instagram'
      ? 'CurveLead isn\'t allowed to post to this Instagram account (needs the instagram_content_publish permission). Reconnect and allow it.'
      : 'CurveLead isn\'t allowed to post to this Page (needs pages_manage_posts and a Page role that can create content). Reconnect and allow it.';
  }
  return String(e?.message || 'Publishing failed.').slice(0, 500);
};

// The actual platform call for one target. deps are injectable for tests.
const publishTarget = async ({ post, account, media, settings, deps = {} }) => {
  const fb = deps.publishToFacebook || publishToFacebook;
  const ig = deps.publishToInstagram || publishToInstagram;
  const gbp = deps.publishToGbp || publishToGbp;
  const gtoken = deps.accessTokenFor || accessTokenFor;
  const problems = platformErrors(account.platform, { caption: post.caption, link_url: post.link_url, media: post.media });
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { status: 422 });

  if (account.platform === 'facebook') {
    return fb({ pageId: account.external_id, token: account.token, caption: post.caption, link_url: post.link_url, media });
  }
  if (account.platform === 'instagram') {
    // Instagram shows links in captions as plain text; append so it's at least there.
    const caption = post.link_url && !post.caption.includes(post.link_url) ? `${post.caption}\n\n${post.link_url}`.trim() : post.caption;
    return ig({ igUserId: account.external_id, token: account.token, caption, media });
  }
  if (account.platform === 'gbp') {
    return gbp({ accountName: account.parent_external_id, locationName: account.external_id, accessToken: await gtoken(settings),
      caption: post.caption, link_url: post.link_url, media });
  }
  throw new Error(`Unknown platform ${account.platform}`);
};

// Post status from its targets.
const rollUp = (targets) => {
  const published = targets.filter(t => t.status === 'published').length;
  const retrying = targets.some(t => t.status !== 'published' && t.retry);
  if (retrying) return 'scheduled';
  if (published === targets.length) return 'published';
  return published ? 'partially_published' : 'failed';
};

const notifyFailure = async (post, failed) => {
  if (!post.created_by || !failed.length) return;
  try {
    const { createNotification } = require('../../controllers/notificationController');
    const where = failed.map(t => t.name || t.platform).join(', ');
    await createNotification(post.tenant_id, post.created_by, 'Social post not published',
      `Your post couldn't be published to ${where}. Open Social to see why and retry.`, 'social_post_failed', 'social_post', post.id);
  } catch (e) { console.error('[social] notify failed:', e.message); }
};

const publishPost = async ({ postId }, deps = {}) => {
  const db = deps.query || query;
  const claimed = (await db(
    `UPDATE social_posts SET status = 'publishing', updated_at = now()
     WHERE id = $1 AND status = 'scheduled' AND COALESCE(next_attempt_at, scheduled_at, now()) <= now() + interval '30 seconds'
     RETURNING *`, [postId])).rows[0];
  if (!claimed) return { skipped: true };
  const post = { ...claimed, media: Array.isArray(claimed.media) ? claimed.media : [] };

  const targets = (await db(
    `SELECT t.*, a.name FROM social_post_targets t JOIN social_accounts a ON a.id = t.account_id AND a.tenant_id = t.tenant_id
     WHERE t.tenant_id = $1 AND t.post_id = $2`, [post.tenant_id, post.id])).rows;
  const sign = deps.signedUrl || signedUrl;
  const media = await Promise.all(post.media.map(async m => ({ type: m.type, url: await sign(m.s3_key) })));
  const settings = (await db('SELECT settings FROM tenants WHERE id = $1', [post.tenant_id])).rows[0]?.settings || {};
  const getAccount = deps.getAccountForPublish || getAccountForPublish;

  const results = [];
  for (const t of targets) {
    if (t.status === 'published' || (t.status === 'failed' && t.attempts >= MAX_ATTEMPTS)) { results.push(t); continue; }
    const attempts = t.attempts + 1;
    await db("UPDATE social_post_targets SET status = 'publishing', attempts = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [post.tenant_id, t.id, attempts]);
    try {
      const account = await getAccount(post.tenant_id, t.account_id);
      if (!account) throw new Error('This account was removed from CurveLead.');
      if (account.platform !== 'gbp' && !account.token) throw new Error('This account has no saved login — reconnect it in Social → Accounts.');
      const r = await publishTarget({ post, account, media, settings, deps });
      await db(
        `UPDATE social_post_targets SET status = 'published', external_post_id = $3, permalink = $4, error = NULL, published_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2`, [post.tenant_id, t.id, r.external_post_id, r.permalink || null]);
      results.push({ ...t, status: 'published' });
    } catch (e) {
      const retry = isRetryable(e) && attempts < MAX_ATTEMPTS;
      const message = friendlyError(t.platform, e);
      if (isAuthError(e)) await (deps.markAccount || markAccount)(post.tenant_id, t.account_id, 'expired', message);
      await db(
        `UPDATE social_post_targets SET status = 'failed', error = $3, attempts = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [post.tenant_id, t.id, retry ? `${message} Retrying automatically.` : message, retry ? attempts : Math.max(attempts, MAX_ATTEMPTS)]);
      results.push({ ...t, status: 'failed', retry, attempts });
    }
  }

  const status = rollUp(results);
  const nextAttempt = status === 'scheduled' ? new Date(Date.now() + retryDelayMs(Math.max(...results.filter(r => r.retry).map(r => r.attempts)))) : null;
  await db(
    `UPDATE social_posts SET status = $3, next_attempt_at = $4, published_at = CASE WHEN $3 IN ('published', 'partially_published') THEN now() ELSE published_at END, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`, [post.tenant_id, post.id, status, nextAttempt]);
  if (nextAttempt) await (deps.enqueue || queues.enqueue)('social:publish', { postId: post.id }, { jobId: `${post.id}-${nextAttempt.getTime()}`, delayMs: nextAttempt - Date.now() });
  if (status === 'failed' || status === 'partially_published') await (deps.notify || notifyFailure)(post, results.filter(r => r.status !== 'published'));
  return { status, targets: results.map(r => ({ id: r.id, status: r.status })) };
};

// Queue a scheduled post for its time (precise with Redis; the sweep below is the safety net).
const schedulePublish = (post, enqueue = queues.enqueue) => {
  const at = new Date(post.next_attempt_at || post.scheduled_at || Date.now()).getTime();
  return enqueue('social:publish', { postId: post.id }, { jobId: `${post.id}-${at}`, delayMs: Math.max(0, at - Date.now()) });
};

// Every minute: queue due posts (covers restarts and in-process mode), and release
// posts stuck in "publishing" after a crash. A target interrupted mid-call may or may
// not have gone out, so it's marked failed for a person to check — never re-sent blindly.
const sweep = async (deps = {}) => {
  const db = deps.query || query;
  const enqueue = deps.enqueue || queues.enqueue;
  const stuck = (await db(
    `UPDATE social_post_targets t SET status = 'failed', attempts = GREATEST(t.attempts, ${MAX_ATTEMPTS}),
       error = 'Publishing was interrupted. Check the page before retrying — it may already be posted.', updated_at = now()
     FROM social_posts p WHERE p.id = t.post_id AND p.tenant_id = t.tenant_id AND p.status = 'publishing'
       AND p.updated_at < now() - interval '${STUCK_AFTER_MIN} minutes' AND t.status = 'publishing'
     RETURNING t.post_id`)).rows;
  for (const postId of new Set(stuck.map(r => r.post_id))) {
    await db(
      `UPDATE social_posts p SET status = CASE WHEN EXISTS (SELECT 1 FROM social_post_targets x WHERE x.post_id = p.id AND x.status = 'published')
         THEN 'partially_published' ELSE 'failed' END, updated_at = now() WHERE p.id = $1 AND p.status = 'publishing'`, [postId]);
  }
  const due = (await db(
    `SELECT id FROM social_posts WHERE status = 'scheduled' AND COALESCE(next_attempt_at, scheduled_at) <= now()
     ORDER BY COALESCE(next_attempt_at, scheduled_at) LIMIT 50`)).rows;
  // Job ids are unique per minute: BullMQ ignores an id it still remembers, and the claim
  // in publishPost already stops duplicates.
  const minute = Math.floor(Date.now() / 60000);
  for (const { id } of due) await enqueue('social:publish', { postId: id }, { jobId: `${id}-sweep-${minute}` });
  return { queued: due.length, released: stuck.length };
};

module.exports = { publishPost, publishTarget, schedulePublish, sweep, rollUp, isRetryable, retryDelayMs, MAX_ATTEMPTS };
