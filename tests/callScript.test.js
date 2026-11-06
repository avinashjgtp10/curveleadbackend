// The per-organization call script lives in tenants.settings.call_script (editable with settings.manage, readable by agents).
const test = require('node:test');
const assert = require('node:assert/strict');

const sqlLog = [];
const db = require('../config/db');
db.query = async (sql, params) => { sqlLog.push([sql, params]); return { rows: [{ id: 't1', settings: { call_script: 'Hello' } }] }; }; // patched BEFORE the controller loads
const { getSettings, updateSettings } = require('../controllers/settingsController');

const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const update = async (body) => { sqlLog.length = 0; const r = res(); await updateSettings({ tenantId: 't1', user: { id: 'u1' }, body }, r); return r; };
const patchSent = () => {
  const call = sqlLog.find(([sql]) => /UPDATE tenants/.test(sql));
  const json = call && call[1].find((p) => typeof p === 'string' && p.startsWith('{'));
  return json ? JSON.parse(json) : undefined;
};

test('a call script is trimmed and stored inside the settings JSON', async () => {
  const r = await update({ call_script: '  Hi, this is Salonox.\nTwo key points…  ' });
  assert.equal(r.code, 200);
  assert.equal(patchSent().call_script, 'Hi, this is Salonox.\nTwo key points…');
});
test('an empty script clears it', async () => {
  const r = await update({ call_script: '   ' });
  assert.equal(r.code, 200); assert.equal(patchSent().call_script, '');
});
test('non-text or over-long scripts are refused and nothing is written', async () => {
  for (const bad of ['x'.repeat(2001), 123, { a: 1 }, ['a'], null]) {
    const r = await update({ call_script: bad });
    assert.equal(r.code, 422, String(bad).slice(0, 20));
    assert.equal(sqlLog.some(([sql]) => /UPDATE tenants/.test(sql)), false);
  }
  assert.equal((await update({ call_script: 'x'.repeat(2000) })).code, 200); // exactly at the limit is fine
});
test('settings that do not mention the script leave it untouched', async () => {
  await update({ website: 'https://example.com' });
  assert.equal(patchSent(), undefined); // no settings JSON patch at all
});
test('GET /api/settings exposes the script at the top level for any logged-in user', async () => {
  const r = res(); await getSettings({ tenantId: 't1' }, r);
  assert.equal(r.body.settings.call_script, 'Hello');
});
