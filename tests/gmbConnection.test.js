const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshGmbConnection } = require('../services/gmbConnection');
const { GbpError } = require('../services/social/gbp');

const settings = { gmb_refresh_token_encrypted: 'x', gmb_account_name: 'Salonox' };
const ok = { accessTokenFor: async () => 'tok' };

test('once Google allows access, accounts and locations are found', async () => {
  const r = await refreshGmbConnection(settings, { ...ok, listLocations: async () => [
    { external_id: 'locations/1', parent_external_id: 'accounts/9', name: 'Shop A', address: 'Pune' },
    { external_id: 'locations/2', parent_external_id: 'accounts/9', name: 'Shop B', address: null }] });
  assert.equal(r.ok, true);
  assert.equal(r.accountId, 'accounts/9');
  assert.equal(r.locations.length, 2);
  assert.equal(r.locations[0].name, 'Shop A');
});

test('a Google account with no business locations is explained, not treated as connected', async () => {
  const r = await refreshGmbConnection(settings, { ...ok, listLocations: async () => [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_locations');
  assert.match(r.message, /doesn't manage any business locations/);
});

test('API switched off in CurveLead\'s Google project: customer gets a calm message, the detail is kept for logs', async () => {
  const err = new GbpError('Google refused listing: disabled', { status: 403, reason: 'SERVICE_DISABLED', service: 'My Business Account Management API', activationUrl: 'https://console.developers.google.com/apis/api/x/overview?project=472081752682' });
  const r = await refreshGmbConnection(settings, { ...ok, listLocations: async () => { throw err; } });
  assert.equal(r.code, 'api_not_enabled');
  assert.match(r.message, /still being switched on/);
  assert.doesNotMatch(r.message, /Cloud|console\.developers|project/i, 'no operator instructions shown to customers');
  assert.match(r.detail, /SERVICE_DISABLED.*My Business Account Management API.*activationUrl|SERVICE_DISABLED/);
  assert.match(r.detail, /console\.developers\.google\.com/);
});

test('other refusals, rate limits, expired logins and outages each get their own message', async () => {
  const run = (error, deps = {}) => refreshGmbConnection(settings, { ...ok, ...deps, listLocations: async () => { throw error; } });
  assert.equal((await run(new GbpError('x', { status: 403, reason: 'PERMISSION_DENIED' }))).code, 'not_approved');
  assert.equal((await run(new GbpError('x', { status: 429 }))).code, 'rate_limited');
  assert.equal((await run(new GbpError('boom', { status: 500 }))).code, 'error');
  const expired = await refreshGmbConnection(settings, { accessTokenFor: async () => { throw new GbpError('The Google connection has expired — reconnect Google in Integrations.'); }, listLocations: async () => [] });
  assert.equal(expired.code, 'reconnect');
});
