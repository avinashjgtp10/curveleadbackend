// Phase 6 against real PostgreSQL (production schema + migrations): the posts API, the
// publish claim under concurrency, tenant isolation and calendar days in the workspace
// timezone. Skipped unless BATCH1_TEST_DATABASE_URL is set (see tests/batch1Sql.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.BATCH1_TEST_DATABASE_URL;
let db = null;
if (url) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase6-test-secret';
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });
  db = { pool, query: (t, p) => pool.query(t, p),
    transaction: async (fn) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } } };
  const p = require.resolve('../config/db');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: db };
}
const skip = !url && 'set BATCH1_TEST_DATABASE_URL to run';
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

const workspace = async (tz) => {
  const t = crypto.randomUUID(), u = crypto.randomUUID();
  await db.query(`INSERT INTO tenants (id, name, slug, email, settings) VALUES ($1,'Social',$2,$3,$4)`,
    [t, `so-${t.slice(0, 8)}`, `so-${t.slice(0, 8)}@example.test`, JSON.stringify({ timezone: tz, country: 'IN' })]);
  await db.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_active) VALUES ($1,$2,'Admin',$3,'x','admin',true)`, [u, t, `u-${t.slice(0, 8)}@example.test`]);
  const { encryptToken } = require('../utils/cryptoSecrets');
  const { ciphertext, keyVersion } = encryptToken('PAGE-TOKEN');
  const fb = (await db.query(`INSERT INTO social_accounts (tenant_id, platform, external_id, name, token_encrypted, key_version) VALUES ($1,'facebook','123','Glow Salon',$2,$3) RETURNING id`, [t, ciphertext, keyVersion])).rows[0].id;
  const ig = (await db.query(`INSERT INTO social_accounts (tenant_id, platform, external_id, parent_external_id, name, token_encrypted, key_version) VALUES ($1,'instagram','178','123','glowsalon',$2,$3) RETURNING id`, [t, ciphertext, keyVersion])).rows[0].id;
  return { t, u, fb, ig, req: (body = {}, params = {}, query = {}) => ({ tenantId: t, user: { id: u, role: 'admin' }, body, params, query }) };
};

test('create → publish once (even when two workers race) → calendar day in the workspace timezone', { skip }, async () => {
  const queues = require('../jobs/queues');
  const queued = [];
  if (!queues._handlers.has('social:publish')) queues.register('social:publish', async (d) => queued.push(d), { attempts: 1 });
  const ctrl = require('../controllers/socialController');
  const { publishPost } = require('../services/social/publisher');
  const w = await workspace('America/New_York');
  const other = await workspace('Asia/Kolkata');
  try {
    // 23:30 New York on 4 Oct = 03:30 UTC on 5 Oct: the calendar must put it on the 4th.
    const at = '2026-10-05T03:30:00Z';
    let r = res();
    await ctrl.createPost(w.req({ caption: 'Open late tonight!', account_ids: [w.fb], scheduled_at: at }), r);
    // The schedule-in-the-past rule depends on today's date; use a time that's always ahead when it isn't.
    if (r.code === 422 && /already passed/.test(r.data.error)) {
      r = res();
      await ctrl.createPost(w.req({ caption: 'Open late tonight!', account_ids: [w.fb], scheduled_at: new Date(Date.now() + 3600e3).toISOString() }), r);
    }
    assert.equal(r.code, 201, JSON.stringify(r.data));
    const post = r.data.post;
    assert.equal(post.status, 'scheduled');
    assert.equal(post.targets.length, 1);

    // Instagram without media is refused before anything is saved.
    const bad = res();
    await ctrl.createPost(w.req({ caption: 'text only', account_ids: [w.ig] }), bad);
    assert.equal(bad.code, 422);
    assert.match(bad.data.error, /no text-only posts/);

    // Another workspace can't see, edit, publish or use these accounts.
    for (const [fn, args] of [['getPost', [{}, { id: post.id }]], ['publishNow', [{}, { id: post.id }]], ['deletePost', [{}, { id: post.id }]]]) {
      const x = res(); await ctrl[fn](other.req(...args), x);
      assert.equal(x.code, 404, fn);
    }
    const steal = res();
    await ctrl.createPost(other.req({ caption: 'x', account_ids: [w.fb] }), steal);
    assert.match(steal.data.error, /no longer connected/);
    const foreignMedia = res();
    await ctrl.createPost(other.req({ caption: 'x', account_ids: [], media: [{ s3_key: `social/${w.t}/a.jpg`, type: 'image' }] }), foreignMedia);
    assert.match(foreignMedia.data.error, /Upload media through CurveLead/);

    // Post now, then two workers race: exactly one calls Facebook.
    const now = res();
    await ctrl.publishNow(w.req({}, { id: post.id }), now);
    assert.equal(now.code, 202);
    let calls = 0;
    const deps = { publishToFacebook: async ({ token }) => { calls++; assert.equal(token, 'PAGE-TOKEN'); await new Promise(rs => setTimeout(rs, 50)); return { external_post_id: '123_456', permalink: 'https://www.facebook.com/123_456' }; },
      notify: async () => {}, signedUrl: async (k) => k };
    const [a, b] = await Promise.all([publishPost({ postId: post.id }, deps), publishPost({ postId: post.id }, deps)]);
    assert.equal(calls, 1);
    assert.deepEqual([a.status || 'skipped', b.status || 'skipped'].sort(), ['published', 'skipped']);

    // Published posts can't be edited.
    const edit = res();
    await ctrl.updatePost(w.req({ caption: 'changed', account_ids: [w.fb] }, { id: post.id }), edit);
    assert.equal(edit.code, 409);

    // Calendar in the workspace timezone.
    const scheduledAt = (await db.query('SELECT scheduled_at FROM social_posts WHERE id = $1', [post.id])).rows[0].scheduled_at;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(scheduledAt);
    const cal = res();
    await ctrl.calendar(w.req({}, {}, { from: day, to: day }), cal);
    assert.equal(cal.data.timezone, 'America/New_York');
    assert.deepEqual(Object.keys(cal.data.days), [day]);
    assert.equal(cal.data.days[day][0].targets[0].status, 'published');
    assert.equal(cal.data.days[day][0].targets[0].permalink, 'https://www.facebook.com/123_456');
    const otherCal = res();
    await ctrl.calendar(other.req({}, {}, { from: day, to: day }), otherCal);
    assert.deepEqual(otherCal.data.days, {});
  } finally {
    await db.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[w.t, other.t]]);
  }
});

test('a failed post can be retried; only the failed accounts are sent again', { skip }, async () => {
  const ctrl = require('../controllers/socialController');
  const { publishPost } = require('../services/social/publisher');
  const queues = require('../jobs/queues');
  if (!queues._handlers.has('social:publish')) queues.register('social:publish', async () => {}, { attempts: 1 });
  const w = await workspace('Asia/Kolkata');
  try {
    const r = res();
    await ctrl.createPost(w.req({ caption: 'Diwali offer', account_ids: [w.fb, w.ig], media: [{ s3_key: `social/${w.t}/a.jpg`, type: 'image', width: 1080, height: 1080 }] }), r);
    assert.equal(r.code, 201, JSON.stringify(r.data));
    const sent = [];
    const deps = { notify: async () => {}, signedUrl: async (k) => k, enqueue: async () => {},
      publishToFacebook: async () => { sent.push('fb'); return { external_post_id: 'f1' }; },
      publishToInstagram: async () => { sent.push('ig'); throw Object.assign(new Error('Instagram couldn\'t process the media.'), { retryable: false }); } };
    const first = await publishPost({ postId: r.data.post.id }, deps);
    assert.equal(first.status, 'partially_published');

    const retry = res();
    await ctrl.retryPost(w.req({}, { id: r.data.post.id }), retry);
    assert.equal(retry.code, 202);
    deps.publishToInstagram = async () => { sent.push('ig'); return { external_post_id: 'i1' }; };
    const second = await publishPost({ postId: r.data.post.id }, deps);
    assert.equal(second.status, 'published');
    assert.deepEqual(sent, ['fb', 'ig', 'ig'], 'Facebook was not posted twice');
  } finally {
    await db.query('DELETE FROM tenants WHERE id = $1', [w.t]);
  }
});

test.after(async () => { if (db) await db.pool.end(); });
