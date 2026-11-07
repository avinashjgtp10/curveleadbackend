const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHandler } = require('../controllers/automationTestSendController');

const res = () => { const r = {}; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const setup = ({ phone = '+919876543210', settings = { whatsapp_phone_number_id: 'p', whatsapp_access_token: 't', whatsapp_business_account_id: 'w' }, templates, sendResult = { success: true } } = {}) => {
  const calls = { sql: [], text: [], template: [] };
  const deps = {
    query: async (sql, params) => { calls.sql.push([sql, params]); return /FROM users/.test(sql) ? { rows: [{ id: 'u1', name: 'Asha', email: 'a@x.io', phone }] } : { rows: [{ settings }] }; },
    whatsapp: {
      listMessageTemplates: async () => ({ success: true, templates: templates || [] }),
      sendTextMessage: async (...a) => { calls.text.push(a); return sendResult; },
      sendTemplate: async (...a) => { calls.template.push(a); return sendResult; },
    },
  };
  return { calls, run: async (body) => { const r = res(); await buildHandler(deps)({ body, user: { id: 'u1' }, tenantId: 't1' }, r); return r; } };
};
const tpl = { name: 'welcome', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] };

test('text test goes only to the signed-in user\'s own profile phone, with sample values filled in', async () => {
  const s = setup();
  const r = await s.run({ to: '+10000000000', lead_id: 'x', step: { channel: 'whatsapp', message: 'Hello {{name}}!' } });
  assert.equal(r.body.sent, true);
  assert.equal(s.calls.text.length, 1);
  assert.equal(s.calls.text[0][0], '+919876543210');
  assert.equal(s.calls.text[0][1], 'Hello Asha!');
  assert.equal(r.body.to_last4, '3210');
  assert.match(r.body.window_note, /24 hours/);
  assert.ok(s.calls.sql.every(([sql]) => !/INSERT|UPDATE/i.test(sql)), 'nothing is written');
});
test('template test sends the approved template with the profile phone', async () => {
  const s = setup({ templates: [tpl] });
  const r = await s.run({ step: { channel: 'whatsapp', approved_template_name: 'welcome', template_language: 'en' } });
  assert.equal(r.body.sent_as, 'template');
  assert.equal(s.calls.template[0][0], '+919876543210');
  assert.deepEqual(JSON.parse(JSON.stringify(s.calls.template[0][3])), [{ type: 'text', text: 'Asha' }]);
});
test('refuses without a profile phone, without WhatsApp, for non-WhatsApp steps, unapproved templates and empty text', async () => {
  assert.equal((await setup({ phone: null }).run({ step: { channel: 'whatsapp', message: 'x' } })).body.code, 'NO_PROFILE_PHONE');
  assert.equal((await setup({ settings: {} }).run({ step: { channel: 'whatsapp', message: 'x' } })).body.code, 'NOT_CONNECTED');
  assert.equal((await setup().run({ step: { channel: 'email', message: 'x' } })).code, 422);
  assert.equal((await setup({ templates: [] }).run({ step: { channel: 'whatsapp', approved_template_name: 'welcome', template_language: 'en' } })).code, 422);
  assert.equal((await setup().run({ step: { channel: 'whatsapp', message: '  ' } })).code, 422);
});
test('outside the 24-hour window the error explains it', async () => {
  const s = setup({ sendResult: { success: false, code: 131047, error: 'More than 24 hours.' } });
  const r = await s.run({ step: { channel: 'whatsapp', message: 'hi' } });
  assert.equal(r.code, 422);
  assert.match(r.body.window_note, /24 hours/);
});
