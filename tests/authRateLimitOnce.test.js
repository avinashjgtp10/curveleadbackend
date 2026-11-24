// One request must consume exactly ONE rate-limit count on every auth route. A duplicate limiter mount
// (e.g. the same limiter on /api/auth twice) silently halves everyone's budget for those routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

Object.assign(process.env, {
  JWT_SECRET: 'test-secret', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'sec',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/google/callback', FRONTEND_URL: 'http://localhost:5173',
});
const { createApiLimiter } = require('../middleware/apiRateLimit');
const mountAuthRoutes = require('../routes/authMounts');

const boot = async (env = { RATE_LIMIT_IP_MAX: '500', RATE_LIMIT_USER_MAX: '2000', RATE_LIMIT_BACKGROUND_USER_MAX: '3000' }) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  mountAuthRoutes(app, createApiLimiter({ env, log: () => {} }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
};

// Requests that never reach the database: missing input, unauthenticated, redirects.
const ROUTES = [
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/login', {}],
  ['POST', '/api/auth/google', {}],
  ['POST', '/api/auth/request-otp', {}],
  ['POST', '/api/auth/verify-otp', {}],
  ['GET', '/api/auth/google/start'],
  ['GET', '/api/auth/google/callback?error=access_denied'],
  ['GET', '/api/v1/auth/google/start'],
  ['GET', '/api/v1/auth/google/callback?error=access_denied'],
];

test('every auth route consumes exactly one rate-limit count per request', async () => {
  const s = await boot();
  try {
    let previous = 500;
    for (const [method, url, body] of ROUTES) {
      const res = await fetch(s.base + url, {
        method, redirect: 'manual',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const remaining = Number(res.headers.get('ratelimit-remaining'));
      assert.equal(previous - remaining, 1, `${method} ${url} consumed ${previous - remaining} counts (status ${res.status})`);
      previous = remaining;
    }
  } finally { await s.close(); }
});

test('the signed-in (per-user) bucket is also counted once on auth routes', async () => {
  const jwt = require('jsonwebtoken');
  const s = await boot({ RATE_LIMIT_USER_MAX: '10', RATE_LIMIT_BACKGROUND_USER_MAX: '10', RATE_LIMIT_IP_MAX: '10' });
  try {
    const headers = { Authorization: `Bearer ${jwt.sign({ userId: 'u1' }, 'test-secret')}` };
    // /auth/me is a background-budget read; the request is rejected by auth later, but the limiter runs first.
    const first = Number((await fetch(`${s.base}/api/auth/me`, { headers })).headers.get('ratelimit-remaining'));
    const second = Number((await fetch(`${s.base}/api/auth/me`, { headers })).headers.get('ratelimit-remaining'));
    assert.equal(first, 9);
    assert.equal(first - second, 1);
  } finally { await s.close(); }
});

test('the configured limits are unchanged and still enforced', async () => {
  const s = await boot({ RATE_LIMIT_IP_MAX: '3', RATE_LIMIT_USER_MAX: '3' });
  try {
    for (let i = 0; i < 3; i++) assert.notEqual((await fetch(`${s.base}/api/auth/me`)).status, 429);
    const blocked = await fetch(`${s.base}/api/auth/me`);
    assert.equal(blocked.status, 429, 'the 4th request is limited: exactly 3 allowed, not 1 or 2');
  } finally { await s.close(); }
});

test('server.js never mounts the limiter twice on the same path, and auth goes through authMounts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mounts = [...src.matchAll(/app\.(?:use|get|post)\(\s*'([^']+)'\s*,\s*apiLimiter/g)].map((m) => m[1]);
  const dupes = mounts.filter((p, i) => mounts.indexOf(p) !== i);
  assert.deepEqual(dupes, [], `apiLimiter mounted more than once on: ${dupes.join(', ')}`);
  assert.ok(!mounts.some((p) => p.startsWith('/api/auth') || p.startsWith('/api/v1/auth')), 'auth must be mounted via routes/authMounts.js');
  assert.match(src, /require\('\.\/routes\/authMounts'\)\(app, apiLimiter\)/);
});
