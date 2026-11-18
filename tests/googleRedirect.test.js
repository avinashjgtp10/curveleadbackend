// Google redirect sign-in: start redirects to Google with a signed state + nonce cookie; callback rejects bad state.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

Object.assign(process.env, {
  JWT_SECRET: 'test-secret', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'sec',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/google/callback', FRONTEND_URL: 'http://localhost:5173',
});
const { googleStart, googleCallback } = require('../controllers/authController');

const boot = async () => {
  const app = express();
  app.get('/google/start', googleStart);
  app.get('/google/callback', googleCallback);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
};

test('start redirects to Google with client id, redirect uri, signed state and a nonce cookie', async () => {
  const s = await boot();
  try {
    const r = await fetch(`${s.base}/google/start`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(loc.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
    assert.equal(loc.searchParams.get('redirect_uri'), process.env.GOOGLE_REDIRECT_URI);
    assert.equal(loc.searchParams.get('response_type'), 'code');
    assert.ok(loc.searchParams.get('state'));
    assert.match(r.headers.get('set-cookie'), /g_oauth_nonce=.*HttpOnly/i);
  } finally { await s.close(); }
});

test('callback without a valid state/cookie never signs anyone in', async () => {
  const s = await boot();
  try {
    for (const q of ['?code=abc&state=forged', '?code=abc', '?error=access_denied']) {
      const r = await fetch(`${s.base}/google/callback${q}`, { redirect: 'manual' });
      assert.equal(r.status, 302);
      const loc = r.headers.get('location');
      assert.match(loc, /^http:\/\/localhost:5173\/login#google_error=/);
      assert.doesNotMatch(loc, /google_token/);
    }
  } finally { await s.close(); }
});
