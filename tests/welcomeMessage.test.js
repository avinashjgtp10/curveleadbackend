const test = require('node:test');
const assert = require('node:assert/strict');
const { createWelcomeSender } = require('../utils/whatsappAutoResponder');

const TEMPLATE = { name: 'thanks_enquiry', language: 'en_US', category: 'UTILITY', status: 'APPROVED' };

function setup({ settings = {}, sessionOpen = false, consent = { allowed: true }, template = { template: TEMPLATE, body: 'Hi {{1}}, thanks for your enquiry' }, sendResult = { success: true, wa_message_id: 'wamid.1' } } = {}) {
  const log = { activities: [], messages: [], text: [], template: [] };
  const base = { whatsapp_auto_responder_enabled: true, whatsapp_phone_number_id: 'p1', whatsapp_access_token: 'tok', ...settings };
  const query = async (sql, args) => {
    if (sql.startsWith('SELECT settings')) return { rows: [{ settings: base }] };
    if (sql.includes('INSERT INTO lead_activities')) log.activities.push(args);
    if (sql.includes('INSERT INTO whatsapp_messages')) { log.messages.push(args); return { rows: [{ id: 'm1' }] }; }
    return { rows: [] };
  };
  const send = createWelcomeSender({
    query, isSessionOpen: async () => sessionOpen,
    checkTemplateConsent: async () => consent, findApprovedTemplate: async () => template,
    sendTextMessage: async (...a) => { log.text.push(a); return sendResult; },
    sendTemplate: async (...a) => { log.template.push(a); return sendResult; },
  });
  return { send, log, lead: { id: 'l1', name: 'Asha Rao', phone: '919999900000' } };
}
const skippedWith = (log, re) => log.activities.some(a => a[2] === 'Welcome message not sent' && re.test(a[3]));

test('a new lead (window closed) gets the approved template with their first name', async () => {
  const { send, log, lead } = setup({ settings: { whatsapp_auto_responder_template: 'thanks_enquiry', whatsapp_auto_responder_message: 'Hi {{name}}' } });
  const r = await send({ tenantId: 't1', lead });
  assert.deepEqual(r, { sent: true, via: 'template' });
  assert.equal(log.text.length, 0, 'free text would be rejected by WhatsApp');
  assert.equal(log.template[0][2], 'en_US');
  assert.equal(log.template[0][3][0].text, 'Asha');
  assert.equal(log.messages[0][2], 'Hi Asha, thanks for your enquiry');
  assert.equal(log.messages[0][3], 'template');
});

test('a lead who messaged in the last 24h gets the free-text welcome', async () => {
  const { send, log, lead } = setup({ sessionOpen: true, settings: { whatsapp_auto_responder_message: 'Hi {{name}}!' } });
  const r = await send({ tenantId: 't1', lead });
  assert.equal(r.via, 'text');
  assert.equal(log.text.length, 1);
});

test('no template chosen for a new lead: nothing is sent and the timeline says why', async () => {
  const { send, log, lead } = setup({ settings: { whatsapp_auto_responder_message: 'Hi {{name}}' } });
  const r = await send({ tenantId: 't1', lead });
  assert.equal(r.sent, false);
  assert.equal(log.text.length + log.template.length, 0);
  assert.ok(skippedWith(log, /approved template/));
});

test('a marketing template to a lead with no opt-in is refused, with the fix named', async () => {
  const { send, log, lead } = setup({ settings: { whatsapp_auto_responder_template: 'promo' }, consent: { allowed: false, reason: 'No WhatsApp marketing opt-in on record for this lead.' } });
  const r = await send({ tenantId: 't1', lead });
  assert.equal(r.sent, false);
  assert.equal(log.template.length, 0);
  assert.ok(skippedWith(log, /opt-in on record.*Utility welcome template/));
});

test('a rejected send is saved as failed and explained on the timeline', async () => {
  const { send, log, lead } = setup({ settings: { whatsapp_auto_responder_template: 'thanks_enquiry' }, sendResult: { success: false, error: 'WhatsApp access was denied. Reconnect in Integrations → WhatsApp to restore sending.' } });
  const r = await send({ tenantId: 't1', lead });
  assert.equal(r.sent, false);
  assert.equal(log.messages[0][6], 'failed');
  assert.ok(skippedWith(log, /access was denied/));
});

test('off, or no phone, or WhatsApp not connected', async () => {
  assert.deepEqual(await setup({ settings: { whatsapp_auto_responder_enabled: false, whatsapp_auto_responder_message: 'x' } }).send({ tenantId: 't', lead: { id: 'l', phone: '1' } }), { sent: false, reason: 'off' });
  const noPhone = setup({ settings: { whatsapp_auto_responder_message: 'x' } });
  await noPhone.send({ tenantId: 't', lead: { id: 'l', name: 'A', phone: '' } });
  assert.ok(skippedWith(noPhone.log, /no phone/));
  const noWa = setup({ settings: { whatsapp_auto_responder_message: 'x', whatsapp_access_token: '' } });
  await noWa.send({ tenantId: 't', lead: noWa.lead });
  assert.ok(skippedWith(noWa.log, /not connected/));
});
