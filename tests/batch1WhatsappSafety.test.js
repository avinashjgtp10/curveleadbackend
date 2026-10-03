const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const consent = require('../services/whatsappConsent');
const guard = require('../services/autoReplyGuard');
const { isOptInMessage, isOptOutMessage } = require('../utils/optOut');

// Batch 1 (C): template consent, bot-loop guard, no repeated confirmations.

test('template category: unknown counts as marketing', () => {
  assert.equal(consent.templateCategory({ category: 'UTILITY' }), 'UTILITY');
  assert.equal(consent.templateCategory({ category: 'authentication' }), 'AUTHENTICATION');
  assert.equal(consent.templateCategory({ category: 'MARKETING' }), 'MARKETING');
  assert.equal(consent.templateCategory(null), 'MARKETING');
});

test('marketing needs a recorded opt-in; messaging first is not one', () => {
  const d = (lead, signals = {}) => consent.decideConsent({ lead, category: 'MARKETING', ...signals }).allowed;
  assert.equal(d({ source: 'meta_ads' }), false);
  assert.equal(d({ source: 'whatsapp' }, { hasInbound: true }), false);
  assert.equal(d({ source: 'manual', whatsapp_opt_in_at: '2026-09-01' }), true);
  assert.equal(d({ source: 'manual', whatsapp_opt_in_at: '2026-09-01', opted_out: true }), false);
});

test('utility reaches opted-in leads and leads who asked to be contacted', () => {
  const d = (lead, signals = {}) => consent.decideConsent({ lead, category: 'UTILITY', ...signals });
  assert.equal(d({ source: 'meta_ads' }).allowed, true, 'lead form');
  assert.equal(d({ source: 'website' }).allowed, true);
  assert.equal(d({ source: 'manual' }, { hasInbound: true }).allowed, true, 'messaged us');
  assert.equal(d({ source: 'manual' }, { hasBooking: true }).allowed, true, 'booked a visit/demo');
  assert.equal(d({ source: 'import' }).allowed, false);
  assert.match(d({ source: 'import' }).reason, /opted in or asked to be contacted/);
  assert.equal(d({ source: 'meta_ads', opted_out: true }).allowed, false, 'opt-out always wins');
});

test('auto-reply phrasing and repeats look automated; ordinary messages do not', () => {
  for (const t of ['Thank you for contacting Glow Salon! We will get back to you shortly.', 'This is an automated message.',
    'Our business hours are 10am to 7pm.', 'Hello! How may I help you today?', 'Welcome to ABC Clinic', 'Reply with 1 for appointments',
    'आपका स्वागत है', 'संपर्क केल्याबद्दल धन्यवाद', 'aapka swagat hai']) {
    assert.ok(guard.looksAutomated(t), t);
  }
  for (const t of ['Yes I want to book for Saturday', 'What is the price for hair spa?', 'Ok', 'Kal 5 baje aa sakti hu']) {
    assert.ok(!guard.looksAutomated(t), t);
  }
  assert.ok(guard.looksAutomated('Please share details', ['please share details', 'hi']), 'repeat of a recent message');
});

const botTurns = (n, text = 'Thank you for contacting ABC Salon! We will get back to you shortly.') => {
  const h = [];
  for (let i = 0; i < n; i++) {
    h.unshift({ direction: 'inbound', message: text });
    h.unshift({ direction: 'outbound', message: `AI reply ${i}`, is_ai_generated: true });
  }
  return h;
};

test('the AI pauses only after 3 AI turns answering automated-looking messages', () => {
  const bot = 'Thank you for contacting ABC Salon! We will get back to you shortly.';
  assert.equal(guard.shouldPauseAi({ text: bot, history: botTurns(2) }), false);
  assert.equal(guard.shouldPauseAi({ text: bot, history: botTurns(3) }), true);
  assert.equal(guard.shouldPauseAi({ text: 'Yes please book me', history: botTurns(5) }), false, 'a human-looking message never pauses');
  const humanInBetween = [...botTurns(2), { direction: 'outbound', message: 'Hi, Riya from the salon here', is_ai_generated: false }, ...botTurns(3)];
  assert.equal(guard.shouldPauseAi({ text: bot, history: humanInBetween }), false, 'a human message resets the count');
});

test('timing alone never pauses the AI', () => {
  // A real person replying instantly, three times, with ordinary text.
  const h = [];
  for (const t of ['hi', 'price?', 'ok']) { h.unshift({ direction: 'inbound', message: t, sent_at: new Date() }); h.unshift({ direction: 'outbound', message: 'AI', is_ai_generated: true, sent_at: new Date() }); }
  assert.equal(guard.shouldPauseAi({ text: 'and timings?', history: h }), false);
});

test('the same confirmation is recognised even when reworded slightly', () => {
  assert.ok(guard.isRepeatOf("You're all set for tomorrow, 3 Oct at 11:00 AM! See you then.", "You're all set for tomorrow, 3 Oct at 11:00 AM. See you then!"));
  assert.ok(!guard.isRepeatOf('Booked for Friday 11 AM', 'What is your budget?'));
  assert.ok(!guard.isRepeatOf('anything', undefined));
});

test('START/SUBSCRIBE opt in; YES does not; STOP still opts out', () => {
  assert.ok(isOptInMessage('START')); assert.ok(isOptInMessage('subscribe!'));
  assert.ok(!isOptInMessage('yes')); assert.ok(!isOptInMessage('please start the course'));
  assert.ok(isOptOutMessage('STOP'));
});

test('a ticked lead-form consent checkbox is an opt-in', () => {
  const { formConsent } = require('../services/metaLeads');
  assert.ok(formConsent({ custom_disclaimer_responses: [{ checkbox_key: 'wa', is_checked: '1' }] }));
  assert.ok(formConsent({ custom_disclaimer_responses: [{ checkbox_key: 'wa', is_checked: true }] }));
  assert.ok(!formConsent({ custom_disclaimer_responses: [{ checkbox_key: 'wa', is_checked: '0' }] }));
  assert.ok(!formConsent({}));
});

// ── broadcast end to end (fake DB + Meta) ───────────────────────────────────
function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, process: { env: {} }, setTimeout, require: k => deps[k] || {} });
  return module.exports;
}
const broadcast = async ({ category, leads, inbound = [] }) => {
  const sent = [];
  const db = { query: async (sql, p) => {
    if (sql.includes('SELECT settings')) return { rows: [{ settings: { whatsapp_business_account_id: 'w', whatsapp_access_token: 't', whatsapp_messaging_limit: 1000 } }] };
    if (sql.includes('INSERT INTO whatsapp_broadcast_reports')) return { rows: [{ id: 'r' }] };
    if (sql.includes('SELECT l.id, l.name')) return { rows: leads };
    if (sql.includes('AS has_inbound')) return { rows: leads.map(l => ({ id: l.id, has_inbound: inbound.includes(l.id), has_booking: false })) };
    if (sql.includes('count(*)::int n')) return { rows: [{ n: 0, known: false }] };
    return { rows: [] };
  } };
  db.transaction = fn => fn(db);
  const ctrl = load('controllers/whatsappBroadcastController.js', {
    '../services/whatsappConsent': consent, '../config/db': db,
    '../utils/messagingLimit': { messagingLimit: async () => 1000 },
    '../utils/whatsappCredentials': { resolveWhatsAppCredentials: async () => ({}) },
    '../services/whatsappService': {
      listMessageTemplates: async () => ({ templates: [{ name: 'offer', language: 'en_US', status: 'APPROVED', category, components: [{ type: 'BODY', text: 'Hi' }] }] }),
      sendTemplate: async (phone) => { sent.push(phone); return { success: true, wa_message_id: 'wa' }; },
    },
  });
  const r = await ctrl.executeBroadcast({ tenantId: 't', userId: 'u', lead_ids: leads.map(l => l.id), template_name: 'offer', language_code: 'en_US', mapping: [] });
  return { ...r, sent };
};

test('a marketing broadcast only reaches opted-in leads, with the reason for the rest', async () => {
  const r = await broadcast({ category: 'MARKETING', leads: [
    { id: 'a', name: 'A', phone: '1', source: 'meta_ads', whatsapp_opt_in_at: '2026-09-01' },
    { id: 'b', name: 'B', phone: '2', source: 'meta_ads' },
    { id: 'c', name: 'C', phone: '3', source: 'manual', whatsapp_opt_in_at: '2026-09-01', opted_out: true },
  ] });
  assert.deepEqual(r.sent, ['1']);
  assert.match(r.results.find(x => x.lead_id === 'b').error, /marketing opt-in/);
  assert.match(r.results.find(x => x.lead_id === 'c').error, /opted out/);
});

test('a utility broadcast reaches leads who asked to be contacted, not cold imports', async () => {
  const r = await broadcast({ category: 'UTILITY', inbound: ['c'], leads: [
    { id: 'a', name: 'A', phone: '1', source: 'meta_ads' },
    { id: 'b', name: 'B', phone: '2', source: 'import' },
    { id: 'c', name: 'C', phone: '3', source: 'manual' },
  ] });
  assert.deepEqual(r.sent, ['1', '3']);
  assert.match(r.results.find(x => x.lead_id === 'b').error, /asked to be contacted/);
});
