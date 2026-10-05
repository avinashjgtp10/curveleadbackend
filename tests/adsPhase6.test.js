const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../services/social/rules');
const { publishToFacebook } = require('../services/social/facebook');
const { publishToInstagram } = require('../services/social/instagram');
const { buildLocalPost, publishToGbp } = require('../services/social/gbp');
const { shapeCaptions } = require('../services/social/captions');
const { publishPost, sweep, rollUp, isRetryable } = require('../services/social/publisher');
const { MetaGraphError } = require('../utils/metaGraph');
const { ownsKey } = require('../services/social/media');

// Phase 6: social posting & scheduling.

const img = (w = 1080, h = 1080) => ({ s3_key: 'social/t/a.jpg', type: 'image', width: w, height: h });
const vid = { s3_key: 'social/t/v.mp4', type: 'video' };

test('the post type follows from the media', () => {
  assert.equal(rules.derivePostType([]), 'feed');
  assert.equal(rules.derivePostType([img()]), 'photo');
  assert.equal(rules.derivePostType([vid]), 'video');
  assert.equal(rules.derivePostType([img(), img()]), 'carousel');
});

test('each platform’s rules are checked before anything is scheduled', () => {
  const v = (p, post) => rules.validatePost({ platforms: [p], ...post }).errors.join(' ');
  assert.match(v('instagram', { caption: 'hi' }), /no text-only posts/);
  assert.match(v('instagram', { caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '), media: [img()] }), /at most 30 hashtags/);
  assert.match(v('instagram', { caption: 'x', media: [img(1080, 1920)] }), /between 4:5/);
  assert.equal(v('instagram', { caption: 'x', media: [img(1080, 1350)] }), '', '4:5 portrait is fine');
  assert.match(v('gbp', { caption: '', media: [img()] }), /needs a description/);
  assert.match(v('gbp', { caption: 'x', media: [vid] }), /videos can't be posted/);
  assert.match(v('gbp', { caption: 'x'.repeat(1501) }), /limit is 1500/);
  assert.match(v('facebook', { caption: 'x', media: [vid, img()] }), /one video on its own/);
  assert.match(v('facebook', {}), /add text, a link/);
  assert.equal(v('facebook', { link_url: 'https://example.com' }), '');
  assert.match(rules.validatePost({ platforms: [] }).errors[0], /Choose at least one account/);
});

test('schedule time must be in the next 75 days', () => {
  const now = new Date('2026-10-04T10:00:00Z');
  const v = (at) => rules.validatePost({ platforms: ['facebook'], caption: 'x', scheduledAt: new Date(at), now }).errors.join(' ');
  assert.match(v('2026-10-04T09:00:00Z'), /already passed/);
  assert.match(v('2027-01-30T10:00:00Z'), /up to 75 days/);
  assert.equal(v('2026-10-05T10:00:00Z'), '');
});

// A fake Graph API that records calls and answers by path.
const fakeGraph = (answer) => {
  const calls = [];
  const graph = async (opts) => { calls.push(opts); return answer(opts, calls); };
  return { graph, calls };
};

test('Facebook: text, one photo, several photos (attached) and a video go to the right endpoints', async () => {
  let f = fakeGraph(() => ({ id: '1_2' }));
  let r = await publishToFacebook({ pageId: '1', token: 't', caption: 'Hello', link_url: 'https://x.y', graph: f.graph });
  assert.deepEqual([f.calls[0].path, f.calls[0].data], ['/1/feed', { message: 'Hello', link: 'https://x.y' }]);
  assert.equal(r.permalink, 'https://www.facebook.com/1_2');

  f = fakeGraph(() => ({ id: 'ph', post_id: '1_3' }));
  r = await publishToFacebook({ pageId: '1', token: 't', caption: 'Pic', media: [{ type: 'image', url: 'u1' }], graph: f.graph });
  assert.deepEqual([f.calls[0].path, f.calls[0].data], ['/1/photos', { url: 'u1', caption: 'Pic' }]);
  assert.equal(r.external_post_id, '1_3');

  let n = 0;
  f = fakeGraph((o) => (o.path === '/1/photos' ? { id: `p${++n}` } : { id: '1_9' }));
  r = await publishToFacebook({ pageId: '1', token: 't', caption: 'Two', media: [{ type: 'image', url: 'a' }, { type: 'image', url: 'b' }], graph: f.graph });
  assert.deepEqual(f.calls.slice(0, 2).map(c => c.data.published), [false, false]);
  assert.deepEqual(f.calls[2].data, { message: 'Two', 'attached_media[0]': { media_fbid: 'p1' }, 'attached_media[1]': { media_fbid: 'p2' } });
  assert.equal(r.external_post_id, '1_9');

  f = fakeGraph(() => ({ id: 'v1' }));
  await publishToFacebook({ pageId: '1', token: 't', caption: 'Vid', media: [{ type: 'video', url: 'v' }], graph: f.graph });
  assert.deepEqual([f.calls[0].path, f.calls[0].data], ['/1/videos', { file_url: 'v', description: 'Vid' }]);
});

const igAnswer = (states = {}) => (o) => {
  if (o.path.endsWith('/content_publishing_limit')) return { data: [{ quota_usage: 3, config: { quota_total: 100 } }] };
  if (o.path.endsWith('/media') && o.method === 'POST') return { id: o.data.media_type === 'CAROUSEL' ? 'car' : `c${Math.random().toString(36).slice(2, 6)}` };
  if (o.path.endsWith('/media_publish')) return { id: 'ig_post' };
  if (o.params?.fields === 'permalink') return { permalink: 'https://instagram.com/p/x' };
  if (o.params?.fields === 'status_code,status') {
    const q = states[o.path] || (states[o.path] = ['FINISHED']);
    return { status_code: q.length > 1 ? q.shift() : q[0] };
  }
  return {};
};

test('Instagram: container → wait until processed → publish; Reels for video; carousels with children', async () => {
  let f = fakeGraph(igAnswer());
  const r = await publishToInstagram({ igUserId: '17', token: 't', caption: 'Hi', media: [{ type: 'image', url: 'u' }], graph: f.graph, _sleep: async () => {} });
  const posts = f.calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts[0].data, { image_url: 'u', caption: 'Hi' });
  assert.deepEqual(posts[1].path, '/17/media_publish');
  assert.deepEqual(r, { external_post_id: 'ig_post', permalink: 'https://instagram.com/p/x' });

  const states = {};
  f = fakeGraph((o) => { if (o.params?.fields === 'status_code,status' && !states[o.path]) states[o.path] = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED']; return igAnswer(states)(o); });
  await publishToInstagram({ igUserId: '17', token: 't', caption: 'Reel', media: [{ type: 'video', url: 'v' }], graph: f.graph, _sleep: async () => {} });
  assert.equal(f.calls.find(c => c.method === 'POST').data.media_type, 'REELS');
  assert.equal(f.calls.filter(c => c.params?.fields === 'status_code,status').length, 3, 'polled until FINISHED');

  f = fakeGraph(igAnswer());
  await publishToInstagram({ igUserId: '17', token: 't', caption: 'Carousel', media: [{ type: 'image', url: 'a' }, { type: 'video', url: 'b' }], graph: f.graph, _sleep: async () => {} });
  const created = f.calls.filter(c => c.method === 'POST' && c.path === '/17/media').map(c => c.data);
  assert.equal(created.length, 3);
  assert.ok(created[0].is_carousel_item && created[1].is_carousel_item && created[1].media_type === 'VIDEO');
  assert.equal(created[2].media_type, 'CAROUSEL');
  assert.equal(created[2].children.split(',').length, 2);
});

test('Instagram: a processing error is final; a used-up daily quota is retried later', async () => {
  let f = fakeGraph((o) => (o.params?.fields === 'status_code,status' ? { status_code: 'ERROR', status: 'bad aspect' } : igAnswer()(o)));
  await assert.rejects(publishToInstagram({ igUserId: '1', token: 't', media: [{ type: 'image', url: 'u' }], graph: f.graph, _sleep: async () => {} }),
    (e) => /couldn't process the media \(bad aspect\)/.test(e.message) && !e.retryable);
  f = fakeGraph((o) => (o.path.endsWith('content_publishing_limit') ? { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } : igAnswer()(o)));
  await assert.rejects(publishToInstagram({ igUserId: '1', token: 't', media: [{ type: 'image', url: 'u' }], graph: f.graph }), (e) => e.retryable && /100 API posts/.test(e.message));
  assert.ok(!f.calls.some(c => c.method === 'POST'), 'nothing created when over the limit');
});

test('Google Business Profile: a standard post with one photo and a Learn more button', async () => {
  assert.deepEqual(buildLocalPost({ caption: 'Open Sunday', link_url: 'https://a.b', media: [{ type: 'image', url: 'p' }] }), {
    languageCode: 'en', summary: 'Open Sunday', topicType: 'STANDARD',
    media: [{ mediaFormat: 'PHOTO', sourceUrl: 'p' }], callToAction: { actionType: 'LEARN_MORE', url: 'https://a.b' },
  });
  const sent = [];
  const http = { post: async (url, body) => { sent.push(url); return { data: { name: 'accounts/1/locations/2/localPosts/9', searchUrl: 'https://g.co/x' } }; } };
  const r = await publishToGbp({ accountName: 'accounts/1', locationName: 'locations/2', accessToken: 'a', caption: 'x', http });
  assert.equal(sent[0], 'https://mybusiness.googleapis.com/v4/accounts/1/locations/2/localPosts');
  assert.equal(r.external_post_id, 'accounts/1/locations/2/localPosts/9');
  const denied = { post: async () => { throw Object.assign(new Error('x'), { response: { status: 403, data: { error: { message: 'API not enabled' } } } }); } };
  await assert.rejects(publishToGbp({ accountName: 'a', locationName: 'l', accessToken: 'a', caption: 'x', http: denied }), (e) => /Business Profile API must be enabled/.test(e.message) && !e.retryable);
});

test('AI captions are cut to the strictest platform and hashtags are clean and capped', () => {
  const r = shapeCaptions({ captions: ['a'.repeat(2000), 'Short one', '', 'fourth'], hashtags: [...Array.from({ length: 40 }, (_, i) => `#tag${i}`), 'tag1', 'local spa!'] }, ['instagram', 'gbp']);
  assert.equal(r.max_length, 1500);
  assert.equal(r.captions.length, 3);
  assert.ok(r.captions[0].length <= 1500 && r.captions[0].endsWith('…'));
  assert.equal(r.hashtags.length, 30);
  assert.ok(r.hashtags.every(h => /^#[\p{L}\p{N}_]+$/u.test(h)));
  assert.equal(new Set(r.hashtags).size, r.hashtags.length);
});

test('media keys from another workspace are refused', () => {
  assert.ok(ownsKey('t1', 'social/t1/a.jpg'));
  assert.ok(!ownsKey('t1', 'social/t2/a.jpg'));
  assert.ok(!ownsKey('t1', 'social/t1/../t2/a.jpg'));
});

// ── publisher with a fake database ──────────────────────────────────────────
const world = ({ claim = true, targets, publish }) => {
  const sql = [], enqueued = [], marked = [], notified = [];
  const post = { id: 'p1', tenant_id: 't1', created_by: 'u1', caption: 'Hello', link_url: null, media: [img()], status: 'publishing' };
  const query = async (text, params) => {
    sql.push({ text, params });
    if (text.includes("SET status = 'publishing', updated_at = now()") && text.includes('UPDATE social_posts')) return { rows: claim ? [post] : [] };
    if (text.includes('FROM social_post_targets t JOIN social_accounts')) return { rows: targets };
    if (text.includes('SELECT settings FROM tenants')) return { rows: [{ settings: {} }] };
    return { rows: [] };
  };
  const deps = {
    query, signedUrl: async (k) => `https://signed/${k}`, enqueue: async (...a) => enqueued.push(a),
    getAccountForPublish: async (tenantId, id) => ({ id, tenant_id: tenantId, platform: targets.find(t => t.account_id === id).platform, external_id: 'x', token: 'tok' }),
    markAccount: async (...a) => marked.push(a), notify: async (p, failed) => notified.push(failed.map(f => f.platform)),
    publishToFacebook: async () => publish('facebook'), publishToInstagram: async () => publish('instagram'),
  };
  return { deps, sql, enqueued, marked, notified };
};
const target = (platform, extra = {}) => ({ id: `t-${platform}`, account_id: `a-${platform}`, platform, status: 'pending', attempts: 0, name: platform, ...extra });

test('a post that is not due or already claimed is left alone (no double publishing)', async () => {
  const w = world({ claim: false, targets: [], publish: () => ({}) });
  assert.deepEqual(await publishPost({ postId: 'p1' }, w.deps), { skipped: true });
  assert.equal(w.sql.length, 1);
  assert.match(w.sql[0].text, /status = 'scheduled'/);
});

test('every target published → published; tenant is the first parameter of every write', async () => {
  const w = world({ targets: [target('facebook'), target('instagram')], publish: (p) => ({ external_post_id: `${p}-1`, permalink: null }) });
  const r = await publishPost({ postId: 'p1' }, w.deps);
  assert.equal(r.status, 'published');
  for (const q of w.sql.filter(q => /UPDATE social_post_targets|UPDATE social_posts SET status = \$3/.test(q.text))) assert.equal(q.params[0], 't1');
  assert.equal(w.enqueued.length, 0);
  assert.equal(w.notified.length, 0);
});

test('a temporary Meta error is retried later; the other platform still goes out', async () => {
  const w = world({ targets: [target('facebook'), target('instagram')], publish: (p) => {
    if (p === 'instagram') throw new MetaGraphError({ code: 2, message: 'Service temporarily unavailable' }, 500);
    return { external_post_id: 'fb-1' };
  } });
  const r = await publishPost({ postId: 'p1' }, w.deps);
  assert.equal(r.status, 'scheduled', 'waiting for the retry');
  assert.equal(w.enqueued.length, 1);
  assert.equal(w.enqueued[0][0], 'social:publish');
  assert.ok(w.enqueued[0][2].delayMs > 60000);
  const failedWrite = w.sql.find(q => q.text.includes("SET status = 'failed'"));
  assert.match(failedWrite.params[2], /Retrying automatically/);
});

test('an expired login is not retried: account marked expired, post partly published, creator notified', async () => {
  const w = world({ targets: [target('facebook'), target('instagram')], publish: (p) => {
    if (p === 'instagram') throw new MetaGraphError({ code: 190, message: 'Error validating access token' }, 400);
    return { external_post_id: 'fb-1' };
  } });
  const r = await publishPost({ postId: 'p1' }, w.deps);
  assert.equal(r.status, 'partially_published');
  const expire = w.sql.find(q => q.text.includes("UPDATE social_accounts SET status = 'expired'"));
  assert.ok(expire, 'account marked expired');
  assert.match(expire.text, /expired_at = COALESCE\(expired_at, now\(\)\)/, 'with the time it expired');
  assert.deepEqual(w.marked, [], 'not the generic status update');
  assert.deepEqual(w.notified, [['instagram']]);
  assert.match(w.sql.find(q => q.text.includes("SET status = 'failed'")).params[2], /login for this account expired/);
});

test('after the last attempt a temporary error becomes a failure', async () => {
  const w = world({ targets: [target('facebook', { attempts: 2, status: 'failed' })], publish: () => { throw new MetaGraphError({ code: 2, message: 'down' }, 500); } });
  const r = await publishPost({ postId: 'p1' }, w.deps);
  assert.equal(r.status, 'failed');
  assert.equal(w.enqueued.length, 0);
});

test('a post that breaks a platform rule fails with the reason instead of calling the platform', async () => {
  let called = false;
  const w = world({ targets: [target('gbp')], publish: () => { called = true; } });
  w.deps.publishToGbp = async () => { called = true; };
  w.deps.accessTokenFor = async () => 'g';
  const original = w.deps.query;
  w.deps.query = async (text, params) => {
    const r = await original(text, params);
    if (text.includes("SET status = 'publishing', updated_at = now()") && r.rows[0]) r.rows[0] = { ...r.rows[0], media: [vid] };
    return r;
  };
  const r = await publishPost({ postId: 'p1' }, w.deps);
  assert.equal(r.status, 'failed');
  assert.ok(!called);
});

test('roll-up and retry classification', () => {
  assert.equal(rollUp([{ status: 'published' }, { status: 'published' }]), 'published');
  assert.equal(rollUp([{ status: 'published' }, { status: 'failed' }]), 'partially_published');
  assert.equal(rollUp([{ status: 'failed' }]), 'failed');
  assert.equal(rollUp([{ status: 'failed', retry: true }]), 'scheduled');
  assert.ok(isRetryable(new MetaGraphError({ code: 4 }, 400)));
  assert.ok(!isRetryable(new MetaGraphError({ code: 190 }, 400)));
  assert.ok(!isRetryable(Object.assign(new Error('rejected'), { status: 422 })));
});

test('the sweep queues due posts with fresh job ids and releases stuck ones without re-sending', async () => {
  const sql = [], enqueued = [];
  const query = async (text, params) => {
    sql.push(text);
    if (text.includes('RETURNING t.post_id')) return { rows: [{ post_id: 'stuck' }] };
    if (text.includes("WHERE status = 'scheduled'")) return { rows: [{ id: 'a' }, { id: 'b' }] };
    return { rows: [] };
  };
  const r = await sweep({ query, enqueue: async (...a) => enqueued.push(a) });
  assert.deepEqual(r, { queued: 2, released: 1 });
  assert.match(sql[0], /may already be posted/);
  assert.ok(enqueued.every(([, , o]) => /-sweep-\d+$/.test(o.jobId)));
});

test('uploads: photos become upright JPEGs ≤ 1440 px with their size recorded; other files are refused', async () => {
  const sharp = require('sharp');
  const { storeUpload } = require('../services/social/media');
  const png = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  const stored = [];
  const upload = async (buf, key, mime) => { stored.push({ buf, key, mime }); return key; };
  const m = await storeUpload({ tenantId: 't1', file: { buffer: png, mimetype: 'image/png', size: png.length }, upload });
  assert.equal(m.type, 'image');
  assert.equal(m.mime, 'image/jpeg');
  assert.deepEqual([m.width, m.height], [1440, 720]);
  assert.match(m.s3_key, /^social\/t1\/[0-9a-f-]{36}\.jpg$/);
  assert.equal((await sharp(stored[0].buf).metadata()).format, 'jpeg');
  await assert.rejects(storeUpload({ tenantId: 't1', file: { buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }, upload }), /JPG, PNG or WEBP/);
  await assert.rejects(storeUpload({ tenantId: 't1', file: { buffer: Buffer.from('x'), mimetype: 'video/mp4', size: 101 * 1024 * 1024 }, upload }), /up to 100 MB/);
});
