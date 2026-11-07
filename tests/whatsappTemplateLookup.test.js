// WhatsApp template lookup for Booking messages. Meta is MOCKED (axios.get is replaced): no network, nothing is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const wa = require('../services/whatsappService');
const booking = require('../services/bookingMessages');

const tpl = (name, status = 'APPROVED', language = 'en_US') => ({ name, status, language, category: 'UTILITY', components: [{ type: 'BODY', text: `Hi {{1}} from ${name}` }] });

const withMeta = async (handler, fn) => {
  const original = axios.get; const calls = [];
  axios.get = async (url, cfg) => { calls.push({ url, params: cfg.params }); return handler(calls.length, cfg.params); };
  wa.__templateCache.clear();
  try { return await fn(calls); } finally { axios.get = original; wa.__templateCache.clear(); }
};
const page = (data, next) => ({ data: { data, ...(next ? { paging: { cursors: { after: next }, next: `https://graph/next?after=${next}` } } : {}) } });
const SETTINGS = (names = {}) => ({ whatsapp_business_account_id: 'waba1', whatsapp_access_token: 'tok', booking_messages: names });

test('lookup ignores case and spaces, and a name counts as verified if ANY language variant is approved', () => {
  const list = [tpl('demo_confirmation', 'PENDING', 'en'), tpl('Demo_Confirmation', 'APPROVED', 'en_US'), tpl('other')];
  const r = booking.lookupTemplate(list, '  DEMO_confirmation ');
  assert.equal(r.state, 'verified'); assert.equal(r.language, 'en_US'); assert.equal(r.template.status, 'APPROVED');
  assert.equal(booking.lookupTemplate(list, '').state, 'none');
  assert.equal(booking.lookupTemplate(list, null).state, 'none');
  assert.equal(booking.lookupTemplate(undefined, 'x').state, 'not_found');
});
test('a template that exists but is not approved says so instead of "not found"', () => {
  const r = booking.lookupTemplate([tpl('demo_confirmation', 'PENDING'), tpl('demo_confirmation', 'REJECTED', 'hi')], 'demo_confirmation');
  assert.equal(r.state, 'not_approved'); assert.deepEqual(r.statuses.sort(), ['PENDING', 'REJECTED']);
  assert.equal(booking.lookupTemplate([tpl('x', 'PAUSED')], 'x').status, 'PAUSED');
  assert.equal(booking.lookupTemplate([tpl('x')], 'y').state, 'not_found');
});

test('every page of Meta\'s template list is read (the first page used to be all we saw)', async () => {
  const first = Array.from({ length: 100 }, (_, i) => tpl(`t${i}`));
  const second = [tpl('demo_confirmation'), tpl('visit_confirmation')];
  await withMeta((n, params) => (n === 1 ? page(first, 'CURSOR1') : page(second)), async (calls) => {
    const r = await wa.listMessageTemplates('waba1', 'tok');
    assert.equal(r.success, true); assert.equal(r.templates.length, 102); assert.equal(r.complete, true);
    assert.equal(calls.length, 2); assert.equal(calls[0].params.after, undefined); assert.equal(calls[1].params.after, 'CURSOR1');
    assert.ok(r.templates.some(t => t.name === 'demo_confirmation'), 'a template on page 2 is found');
    await wa.listMessageTemplates('waba1', 'tok'); assert.equal(calls.length, 2, 'the full list is cached for a minute');
  });
});
test('a runaway list stops at 10 pages and is reported as incomplete, not silently cut', async () => {
  await withMeta((n) => page([tpl(`p${n}`)], `C${n}`), async (calls) => {
    const r = await wa.listMessageTemplates('waba1', 'tok');
    assert.equal(calls.length, 10); assert.equal(r.complete, false); assert.equal(r.templates.length, 10);
    const missing = await booking.findApprovedTemplate(SETTINGS(), 'nope');
    assert.equal(missing.code, 'not_found'); assert.match(missing.error, /Only part of a very large template list/);
  });
});

test('the sender and the screen explain the three failure cases differently', async () => {
  await withMeta(() => page([tpl('welcome_msg'), tpl('demo_confirmation', 'PENDING')]), async () => {
    const ok = await booking.findApprovedTemplate(SETTINGS(), 'welcome_msg');
    assert.equal(ok.template.name, 'welcome_msg'); assert.match(ok.body, /Hi \{\{1\}\}/); assert.equal(ok.error, undefined);
    const pending = await booking.findApprovedTemplate(SETTINGS(), 'demo_confirmation');
    assert.equal(pending.code, 'not_approved'); assert.match(pending.error, /is pending in WhatsApp Manager/);
    const gone = await booking.findApprovedTemplate(SETTINGS(), 'deleted_one');
    assert.equal(gone.code, 'not_found'); assert.match(gone.error, /wasn't found in your WhatsApp account/);
  });
});
test('when Meta cannot be reached the answer is "couldn\'t verify", never "not found"', async () => {
  const err = (status, code) => Object.assign(new Error('boom'), { response: { status, data: { error: { code, message: 'x' } } } });
  await withMeta(() => { throw err(401, 190); }, async () => {
    const r = await booking.findApprovedTemplate(SETTINGS(), 'demo_confirmation');
    assert.equal(r.code, 'unverified'); assert.match(r.error, /access token has expired/);
  });
  await withMeta(() => { throw err(500); }, async () => {
    const r = await booking.findApprovedTemplate(SETTINGS(), 'demo_confirmation');
    assert.equal(r.code, 'unverified'); assert.match(r.error, /Could not load WhatsApp templates/);
  });
});

test('the settings screen gets a verdict per chosen template, from the same list the sender uses', async () => {
  const names = { demo_confirmation_template: 'demo_confirmation', visit_confirmation_template: 'visit_confirmation', demo_reminder_template: 'old_removed', visit_reminder_template: '' };
  await withMeta(() => page([tpl('demo_confirmation'), tpl('visit_confirmation', 'REJECTED')]), async () => {
    const checks = await booking.checkTemplates(SETTINGS(names));
    assert.deepEqual(Object.keys(checks).sort(), ['demo_confirmation_template', 'demo_reminder_template', 'visit_confirmation_template']); // blank ones are not checked
    assert.equal(checks.demo_confirmation_template.state, 'verified'); assert.equal(checks.demo_confirmation_template.language, 'en_US');
    assert.equal(checks.visit_confirmation_template.state, 'not_approved'); assert.match(checks.visit_confirmation_template.message, /rejected/);
    assert.equal(checks.demo_reminder_template.state, 'not_found');
  });
  await withMeta(() => { throw Object.assign(new Error('x'), { response: { status: 400, data: { error: { code: 190 } } } }); }, async () => {
    const checks = await booking.checkTemplates(SETTINGS(names));
    for (const c of Object.values(checks)) { assert.equal(c.state, 'unverified'); assert.match(c.message, /reconnect/i); }
  });
  assert.deepEqual(await booking.checkTemplates(SETTINGS({})), {}); // nothing chosen, nothing to check (and no Meta call)
});
