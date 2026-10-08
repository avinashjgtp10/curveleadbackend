const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { parseVersion, compareVersions, getAppVersionConfig } = require('../utils/appVersion');

test('compareVersions is numeric, not lexicographic', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.0.1', '1.0.1'), 0);
  assert.equal(compareVersions('1.0.2', '1.0.1'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1); // string compare would say -1
  assert.equal(compareVersions('v2.0.0', '1.99.99'), 1);
});

test('invalid versions are rejected', () => {
  for (const bad of ['', 'abc', '1.0', '1.0.0.0', '1.0.x', null, undefined, 5, '-1.0.0']) {
    assert.equal(parseVersion(bad), null, String(bad));
  }
  assert.equal(compareVersions('abc', '1.0.0'), null);
});

test('defaults when nothing is configured', () => {
  const c = getAppVersionConfig({});
  assert.equal(c.android.latestVersion, '1.0.0');
  assert.equal(c.android.minimumVersion, '1.0.0');
  assert.match(c.android.storeUrl, /play\.google\.com.*com\.curvelead/);
  assert.equal(c.ios.storeUrl, null); // missing optional store url
  assert.ok(c.releaseNotes.length > 0);
});

test('android and ios are configured independently', () => {
  const c = getAppVersionConfig({
    APP_ANDROID_LATEST_VERSION: '1.2.0', APP_ANDROID_MINIMUM_VERSION: '1.1.0',
    APP_IOS_LATEST_VERSION: '1.0.5', APP_IOS_MINIMUM_VERSION: '1.0.0',
    APP_IOS_STORE_URL: 'https://apps.apple.com/app/id123',
    APP_RELEASE_NOTES: ' Fixes ',
  });
  assert.deepEqual(c.android.latestVersion, '1.2.0');
  assert.deepEqual(c.android.minimumVersion, '1.1.0');
  assert.equal(c.ios.latestVersion, '1.0.5');
  assert.equal(c.ios.storeUrl, 'https://apps.apple.com/app/id123');
  assert.equal(c.releaseNotes, 'Fixes');
});

test('invalid values fall back; minimum is clamped to latest', () => {
  const c = getAppVersionConfig({
    APP_ANDROID_LATEST_VERSION: 'garbage', APP_ANDROID_STORE_URL: 'javascript:alert(1)',
    APP_IOS_LATEST_VERSION: '1.0.0', APP_IOS_MINIMUM_VERSION: '2.0.0',
  });
  assert.equal(c.android.latestVersion, '1.0.0');
  assert.match(c.android.storeUrl, /^https:\/\/play\.google\.com/);
  assert.equal(c.ios.minimumVersion, '1.0.0');
});

test('GET /api/app/version is public and returns only update metadata', async () => {
  Object.assign(process.env, { APP_ANDROID_LATEST_VERSION: '1.0.1', APP_ANDROID_MINIMUM_VERSION: '1.0.0' });
  const app = express();
  app.use('/api/app', require('../routes/app'));
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/app/version`); // no Authorization header
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(Object.keys(body.data).sort(), ['android', 'ios', 'releaseNotes']);
    assert.deepEqual(Object.keys(body.data.android).sort(), ['latestVersion', 'minimumVersion', 'storeUrl']);
    assert.equal(body.data.android.latestVersion, '1.0.1');
  } finally {
    server.close();
    delete process.env.APP_ANDROID_LATEST_VERSION; delete process.env.APP_ANDROID_MINIMUM_VERSION;
  }
});
