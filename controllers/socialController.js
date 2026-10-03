const { query, transaction } = require('../config/db');
const { exchangeForLongLived, inspectToken, saveToken } = require('../services/metaAds/client');
const accounts = require('../services/social/accounts');
const { storeUpload, withPreviewUrls, ownsKey } = require('../services/social/media');
const { validatePost, derivePostType } = require('../services/social/rules');
const { schedulePublish } = require('../services/social/publisher');
const { generateCaptions } = require('../services/social/captions');
const { getWorkspaceLocale } = require('../utils/workspaceLocale');
const { isSchemaError, schemaErrorMessage } = require('../utils/schemaErrors');

// Social posting (Ads & Social Phase 6). Every query is scoped to req.tenantId.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITABLE = ['draft', 'scheduled'];
const bad = (res, error, status = 422) => res.status(status).json({ error });
const fail = (label) => (e, res) => {
  if (e.status && e.status < 500) return bad(res, e.message, e.status);
  if (isSchemaError(e)) return res.status(503).json({ code: 'MIGRATION_PENDING', error: schemaErrorMessage(e) });
  if (e.name === 'MetaGraphError') return bad(res, `Facebook: ${e.message}`, 400);
  if (e.name === 'GbpError') return bad(res, e.message, 400);
  console.error(`[social] ${label}:`, e);
  res.status(500).json({ error: `${label} failed. Please try again.` });
};

// ── accounts ────────────────────────────────────────────────────────────────

// GET /api/social/accounts
const listAccounts = async (req, res) => {
  try {
    const [rows, meta, settings] = await Promise.all([
      accounts.listAccounts(req.tenantId),
      query("SELECT count(*)::int n FROM ad_oauth_tokens WHERE tenant_id = $1 AND provider = 'meta' AND status = 'active'", [req.tenantId]),
      query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]),
    ]);
    res.json({ accounts: rows, facebook_connected: meta.rows[0].n > 0, google_connected: !!settings.rows[0]?.settings?.gmb_refresh_token_encrypted });
  } catch (e) { fail('Load social accounts')(e, res); }
};

// POST /api/social/accounts/connect { user_token } — Facebook login → Pages + Instagram.
const connectMeta = async (req, res) => {
  try {
    const { user_token } = req.body || {};
    if (typeof user_token !== 'string' || user_token.length < 20) return bad(res, 'user_token required.');
    const token = await exchangeForLongLived(user_token);
    const info = await inspectToken(token);
    if (!info.is_valid || !info.user_id) return bad(res, 'Facebook did not return a valid login. Please try again.', 400);
    if (!info.scopes.includes('pages_show_list')) return bad(res, 'Allow CurveLead to see your Pages when logging in with Facebook.', 400);
    const tokenId = await saveToken({ tenantId: req.tenantId, userId: req.user.id, externalUserId: info.user_id, token, scopes: info.scopes, expiresAt: info.expires_at });
    const found = await accounts.discoverMetaAccounts({ tenantId: req.tenantId, tokenId, token, scopes: info.scopes });
    const missing = ['pages_manage_posts', 'instagram_content_publish'].filter(s => !info.scopes.includes(s));
    res.json({ ...found, missing_scopes: missing });
  } catch (e) { fail('Connect Facebook')(e, res); }
};

// POST /api/social/accounts/refresh — re-read Pages/Instagram from logins already connected.
const refreshMeta = async (req, res) => {
  try { res.json(await accounts.refreshMetaAccounts(req.tenantId)); } catch (e) { fail('Refresh accounts')(e, res); }
};

// POST /api/social/accounts/gbp — load Google Business Profile locations.
const connectGbp = async (req, res) => {
  try { res.json(await accounts.discoverGbpAccounts(req.tenantId)); } catch (e) { fail('Load Google locations')(e, res); }
};

// PATCH /api/social/accounts/:id { is_active }
const updateAccount = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    if (typeof req.body?.is_active !== 'boolean') return bad(res, 'is_active must be true or false.');
    const { rows } = await query('UPDATE social_accounts SET is_active = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING id, is_active',
      [req.tenantId, req.params.id, req.body.is_active]);
    if (!rows[0]) return bad(res, 'Account not found.', 404);
    res.json(rows[0]);
  } catch (e) { fail('Update account')(e, res); }
};

// ── media + captions ────────────────────────────────────────────────────────

// POST /api/social/media (multipart "file")
const uploadMedia = async (req, res) => {
  try {
    const item = await storeUpload({ tenantId: req.tenantId, file: req.file });
    const [withUrl] = await withPreviewUrls([item]);
    res.status(201).json({ media: withUrl });
  } catch (e) { fail('Upload')(e, res); }
};

// POST /api/social/captions { prompt, language, platforms }
const captions = async (req, res) => {
  try {
    const { prompt, language, platforms } = req.body || {};
    const t = (await query('SELECT name, settings FROM tenants WHERE id = $1', [req.tenantId])).rows[0] || {};
    res.json(await generateCaptions({
      prompt, language, platforms: Array.isArray(platforms) ? platforms.filter(p => ['facebook', 'instagram', 'gbp'].includes(p)) : [],
      businessName: t.name, businessAbout: t.settings?.ai_knowledge?.about || t.settings?.business_description || '',
    }));
  } catch (e) { fail('Write captions')(e, res); }
};

// ── posts ───────────────────────────────────────────────────────────────────

const loadTargets = async (tenantId, postIds) => postIds.length ? (await query(
  `SELECT t.id, t.post_id, t.account_id, t.platform, t.status, t.external_post_id, t.permalink, t.error, t.attempts, t.published_at,
          a.name AS account_name, a.username, a.picture_url
   FROM social_post_targets t JOIN social_accounts a ON a.id = t.account_id AND a.tenant_id = t.tenant_id
   WHERE t.tenant_id = $1 AND t.post_id = ANY($2::uuid[]) ORDER BY a.platform, a.name`, [tenantId, postIds])).rows : [];

const present = async (tenantId, posts) => {
  const targets = await loadTargets(tenantId, posts.map(p => p.id));
  return Promise.all(posts.map(async p => ({
    ...p, media: await withPreviewUrls(Array.isArray(p.media) ? p.media : []), targets: targets.filter(t => t.post_id === p.id),
  })));
};

// Checks the body and the chosen accounts. Returns { values, accountRows } or throws 422.
const readPostBody = async (tenantId, body, { draft }) => {
  const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
  const link_url = typeof body.link_url === 'string' && body.link_url.trim() ? body.link_url.trim() : null;
  const media = Array.isArray(body.media) ? body.media : [];
  if (media.length > 10) throw Object.assign(new Error('At most 10 photos or videos per post.'), { status: 422 });
  for (const m of media) {
    if (!ownsKey(tenantId, m?.s3_key) || !['image', 'video'].includes(m?.type)) throw Object.assign(new Error('Upload media through CurveLead first.'), { status: 422 });
  }
  const cleanMedia = media.map(m => ({ s3_key: m.s3_key, type: m.type, mime: m.mime || null, width: m.width || null, height: m.height || null }));
  const ids = [...new Set(Array.isArray(body.account_ids) ? body.account_ids.filter(id => UUID.test(id)) : [])];
  const accountRows = ids.length ? (await query(
    'SELECT id, platform, name, status, is_active FROM social_accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, ids])).rows : [];
  if (accountRows.length !== ids.length) throw Object.assign(new Error('One of the chosen accounts is no longer connected.'), { status: 422 });
  const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;
  if (scheduledAt && !/(Z|[+-]\d{2}:\d{2})$/.test(String(body.scheduled_at))) throw Object.assign(new Error('scheduled_at must include a timezone (ISO 8601).'), { status: 422 });

  if (!draft) {
    const { errors } = validatePost({ caption, link_url, media: cleanMedia, platforms: accountRows.map(a => a.platform), scheduledAt });
    const off = accountRows.filter(a => a.status !== 'active');
    if (off.length) errors.push(`Reconnect ${off.map(a => a.name).join(', ')} before posting.`);
    if (errors.length) throw Object.assign(new Error(errors.join(' ')), { status: 422, errors });
  }
  return { values: { caption, link_url, media: cleanMedia, post_type: derivePostType(cleanMedia), scheduledAt }, accountRows };
};

const replaceTargets = async (client, tenantId, postId, accountRows) => {
  await client.query("DELETE FROM social_post_targets WHERE tenant_id = $1 AND post_id = $2 AND status <> 'published'", [tenantId, postId]);
  for (const a of accountRows) {
    await client.query(
      `INSERT INTO social_post_targets (post_id, tenant_id, account_id, platform) VALUES ($1, $2, $3, $4)
       ON CONFLICT (post_id, account_id) DO NOTHING`, [postId, tenantId, a.id, a.platform]);
  }
};

// GET /api/social/posts?status=&from=&to=
const listPosts = async (req, res) => {
  try {
    const params = [req.tenantId];
    let where = 'tenant_id = $1';
    if (req.query.status) { params.push(String(req.query.status).split(',')); where += ` AND status = ANY($${params.length}::text[])`; }
    if (req.query.from) { params.push(new Date(req.query.from)); where += ` AND COALESCE(scheduled_at, published_at, created_at) >= $${params.length}`; }
    if (req.query.to) { params.push(new Date(req.query.to)); where += ` AND COALESCE(scheduled_at, published_at, created_at) < $${params.length}`; }
    const posts = (await query(`SELECT * FROM social_posts WHERE ${where} ORDER BY COALESCE(scheduled_at, published_at, created_at) DESC LIMIT 200`, params)).rows;
    res.json({ posts: await present(req.tenantId, posts) });
  } catch (e) { fail('Load posts')(e, res); }
};

// GET /api/social/posts/:id
const getPost = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const post = (await query('SELECT * FROM social_posts WHERE tenant_id = $1 AND id = $2', [req.tenantId, req.params.id])).rows[0];
    if (!post) return bad(res, 'Post not found.', 404);
    res.json({ post: (await present(req.tenantId, [post]))[0] });
  } catch (e) { fail('Load post')(e, res); }
};

// POST /api/social/posts { caption, link_url, media, account_ids, scheduled_at?, draft? }
// No scheduled_at (and not a draft) = post now.
const createPost = async (req, res) => {
  try {
    const draft = !!req.body?.draft;
    const { values, accountRows } = await readPostBody(req.tenantId, req.body || {}, { draft });
    const post = await transaction(async (client) => {
      const p = (await client.query(
        `INSERT INTO social_posts (tenant_id, created_by, caption, link_url, media, post_type, scheduled_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.tenantId, req.user.id, values.caption, values.link_url, JSON.stringify(values.media), values.post_type,
          draft ? values.scheduledAt : (values.scheduledAt || new Date()), draft ? 'draft' : 'scheduled'])).rows[0];
      await replaceTargets(client, req.tenantId, p.id, accountRows);
      return p;
    });
    if (post.status === 'scheduled') await schedulePublish(post);
    res.status(201).json({ post: (await present(req.tenantId, [post]))[0] });
  } catch (e) {
    if (e.errors) return res.status(422).json({ error: e.message, errors: e.errors });
    fail('Save post')(e, res);
  }
};

// PUT /api/social/posts/:id — only before publishing starts.
const updatePost = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const draft = !!req.body?.draft;
    const { values, accountRows } = await readPostBody(req.tenantId, req.body || {}, { draft });
    const post = await transaction(async (client) => {
      const p = (await client.query(
        `UPDATE social_posts SET caption = $3, link_url = $4, media = $5, post_type = $6, scheduled_at = $7, status = $8,
           next_attempt_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = ANY($9::text[]) RETURNING *`,
        [req.tenantId, req.params.id, values.caption, values.link_url, JSON.stringify(values.media), values.post_type,
          draft ? values.scheduledAt : (values.scheduledAt || new Date()), draft ? 'draft' : 'scheduled', EDITABLE])).rows[0];
      if (!p) return null;
      await replaceTargets(client, req.tenantId, p.id, accountRows);
      return p;
    });
    if (!post) return bad(res, 'This post is already publishing or published, so it can\'t be edited.', 409);
    if (post.status === 'scheduled') await schedulePublish(post);   // an earlier job for the old time finds nothing due and stops
    res.json({ post: (await present(req.tenantId, [post]))[0] });
  } catch (e) {
    if (e.errors) return res.status(422).json({ error: e.message, errors: e.errors });
    fail('Save post')(e, res);
  }
};

// POST /api/social/posts/:id/publish-now
const publishNow = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const p = (await query('SELECT * FROM social_posts WHERE tenant_id = $1 AND id = $2', [req.tenantId, req.params.id])).rows[0];
    if (!p) return bad(res, 'Post not found.', 404);
    if (!EDITABLE.includes(p.status)) return bad(res, 'This post is already publishing or published.', 409);
    const platforms = (await query('SELECT platform FROM social_post_targets WHERE tenant_id = $1 AND post_id = $2', [req.tenantId, p.id])).rows.map(r => r.platform);
    const { errors } = validatePost({ caption: p.caption, link_url: p.link_url, media: p.media || [], platforms });
    if (errors.length) return res.status(422).json({ error: errors.join(' '), errors });
    const post = (await query(
      `UPDATE social_posts SET status = 'scheduled', scheduled_at = now(), next_attempt_at = NULL, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = ANY($3::text[]) RETURNING *`, [req.tenantId, p.id, EDITABLE])).rows[0];
    if (!post) return bad(res, 'This post is already publishing or published.', 409);
    await schedulePublish(post);
    res.status(202).json({ queued: true });
  } catch (e) { fail('Publish post')(e, res); }
};

// POST /api/social/posts/:id/retry — try the failed accounts again.
const retryPost = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const post = await transaction(async (client) => {
      const p = (await client.query(
        `UPDATE social_posts SET status = 'scheduled', next_attempt_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status IN ('failed', 'partially_published') RETURNING *`, [req.tenantId, req.params.id])).rows[0];
      if (!p) return null;
      await client.query("UPDATE social_post_targets SET status = 'pending', attempts = 0, error = NULL, updated_at = now() WHERE tenant_id = $1 AND post_id = $2 AND status = 'failed'",
        [req.tenantId, p.id]);
      return p;
    });
    if (!post) return bad(res, 'Only failed or partly published posts can be retried.', 409);
    await schedulePublish(post);
    res.status(202).json({ queued: true });
  } catch (e) { fail('Retry post')(e, res); }
};

// DELETE /api/social/posts/:id — removes it from CurveLead (published posts stay on the platforms).
const deletePost = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const { rows } = await query("DELETE FROM social_posts WHERE tenant_id = $1 AND id = $2 AND status <> 'publishing' RETURNING id", [req.tenantId, req.params.id]);
    if (!rows[0]) return bad(res, 'Post not found, or it is publishing right now.', 404);
    res.json({ deleted: rows[0].id });
  } catch (e) { fail('Delete post')(e, res); }
};

// GET /api/social/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — posts by day in the workspace timezone.
const calendar = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return bad(res, 'from and to must be YYYY-MM-DD.');
    const { timezone } = await getWorkspaceLocale(req.tenantId);
    const posts = (await query(
      `SELECT p.*, to_char(COALESCE(p.scheduled_at, p.published_at, p.created_at) AT TIME ZONE $4, 'YYYY-MM-DD') AS day
       FROM social_posts p
       WHERE p.tenant_id = $1 AND p.status <> 'cancelled'
         AND COALESCE(p.scheduled_at, p.published_at, p.created_at) >= ($2::date)::timestamp AT TIME ZONE $4
         AND COALESCE(p.scheduled_at, p.published_at, p.created_at) < ($3::date + 1)::timestamp AT TIME ZONE $4
       ORDER BY COALESCE(p.scheduled_at, p.published_at, p.created_at)`, [req.tenantId, from, to, timezone])).rows;
    const shown = await present(req.tenantId, posts);
    const days = {};
    for (const p of shown) (days[p.day] = days[p.day] || []).push(p);
    res.json({ timezone, days });
  } catch (e) { fail('Load calendar')(e, res); }
};

module.exports = { listAccounts, connectMeta, refreshMeta, connectGbp, updateAccount, uploadMedia, captions,
  listPosts, getPost, createPost, updatePost, publishNow, retryPost, deletePost, calendar };
