// Foreground vs background rate-limit budgets, 429 shape, and one-log-per-key. Real express app on an ephemeral port.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createApiLimiter, isBackgroundPoll } = require('../middleware/apiRateLimit');

process.env.JWT_SECRET = 'test-secret';
const token = (userId) => jwt.sign({ userId }, 'test-secret');

const boot = async (env, log = () => {}) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createApiLimiter({ env, log }));
  app.all('*', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { user, method = 'GET', ip } = {}) =>
    fetch(base + path, { method, headers: { ...(user ? { Authorization: `Bearer ${token(user)}` } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) } });
  return { base, call, close: () => new Promise((r) => server.close(r)) };
};

test('only read-only polling GETs are background; everything else is foreground', () => {
  const bg = (method, url) => isBackgroundPoll({ method, originalUrl: url });
  assert.equal(bg('GET', '/api/notifications'), true);
  assert.equal(bg('GET', '/api/notifications/count?x=1'), true);
  assert.equal(bg('GET', '/api/whatsapp/unread-count'), true);
  assert.equal(bg('GET', '/api/whatsapp/conversation/abc-123'), true);
  assert.equal(bg('GET', '/api/leads'), false);
  assert.equal(bg('POST', '/api/notifications'), false);
  assert.equal(bg('PUT', '/api/notifications/read-all'), false);
  assert.equal(bg('GET', '/api/whatsapp/conversation/a/b'), false);
  assert.equal(bg('GET', '/api/notifications/groups'), false);
});

test('exhausting the polling budget does not block loading leads', async () => {
  const s = await boot({ RATE_LIMIT_USER_MAX: '5', RATE_LIMIT_BACKGROUND_USER_MAX: '3', RATE_LIMIT_IP_MAX: '5' });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.call('/api/notifications', { user: 'u1' })).status, 200);
    assert.equal((await s.call('/api/notifications', { user: 'u1' })).status, 429); // polling is limited…
    for (let i = 0; i < 5; i++) assert.equal((await s.call('/api/leads', { user: 'u1' })).status, 200); // …leads still load
    assert.equal((await s.call('/api/leads', { user: 'u1' })).status, 429); // foreground has its own limit
  } finally { await s.close(); }
});

test('foreground traffic does not eat the polling budget either', async () => {
  const s = await boot({ RATE_LIMIT_USER_MAX: '2', RATE_LIMIT_BACKGROUND_USER_MAX: '3', RATE_LIMIT_IP_MAX: '5' });
  try {
    for (let i = 0; i < 2; i++) await s.call('/api/leads', { user: 'u1' });
    assert.equal((await s.call('/api/leads', { user: 'u1' })).status, 429);
    assert.equal((await s.call('/api/whatsapp/unread-count', { user: 'u1' })).status, 200);
  } finally { await s.close(); }
});

test('users have separate buckets even from one IP; anonymous traffic is keyed by IP', async () => {
  const s = await boot({ RATE_LIMIT_USER_MAX: '2', RATE_LIMIT_IP_MAX: '2' });
  try {
    for (let i = 0; i < 2; i++) await s.call('/api/leads', { user: 'a', ip: '1.1.1.1' });
    assert.equal((await s.call('/api/leads', { user: 'a', ip: '1.1.1.1' })).status, 429);
    assert.equal((await s.call('/api/leads', { user: 'b', ip: '1.1.1.1' })).status, 200); // colleague on the same IP is fine
    for (let i = 0; i < 2; i++) await s.call('/api/auth/login', { method: 'POST', ip: '2.2.2.2' });
    assert.equal((await s.call('/api/auth/login', { method: 'POST', ip: '2.2.2.2' })).status, 429);
    assert.equal((await s.call('/api/auth/login', { method: 'POST', ip: '3.3.3.3' })).status, 200);
  } finally { await s.close(); }
});

test('a limited response says how long to wait, and the cause is logged once per key', async () => {
  const lines = [];
  const s = await boot({ RATE_LIMIT_USER_MAX: '1', RATE_LIMIT_IP_MAX: '1' }, (l) => lines.push(JSON.parse(l)));
  try {
    await s.call('/api/leads?search=x', { user: 'u9' });
    const r1 = await s.call('/api/leads?search=x', { user: 'u9' });
    const r2 = await s.call('/api/leads', { user: 'u9' });
    assert.equal(r1.status, 429);
    const body = await r1.json();
    assert.equal(body.code, 'RATE_LIMITED');
    assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 900);
    assert.match(body.error, /^Too many requests\. Please try again in /);
    assert.equal(Number(r1.headers.get('retry-after')), body.retryAfterSeconds);
    assert.ok(r1.headers.get('ratelimit-limit'));
    assert.equal(r2.status, 429);
    assert.equal(lines.length, 1); // two rejections, one log line
    assert.deepEqual({ evt: lines[0].evt, bucket: lines[0].bucket, key: lines[0].key, path: lines[0].path }, { evt: 'rate_limited', bucket: 'foreground', key: 'user:u9', path: '/api/leads' });
    assert.ok(!JSON.stringify(lines[0]).includes('search=x'), 'query strings (may hold PII) are not logged');
  } finally { await s.close(); }
});

test('an invalid or expired token falls back to the IP bucket instead of crashing', async () => {
  const s = await boot({ RATE_LIMIT_USER_MAX: '9', RATE_LIMIT_IP_MAX: '1' });
  try {
    const bad = () => fetch(`${s.base}/api/leads`, { headers: { Authorization: 'Bearer not.a.jwt' } });
    assert.equal((await bad()).status, 200);
    assert.equal((await bad()).status, 429); // IP limit (1) applies, not the user limit (9)
  } finally { await s.close(); }
});
