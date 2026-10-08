const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { module, exports: module.exports, console, Date, Map, Set, JSON, process, require: key => deps[key] || {} });
  return module.exports;
}

const BOOKING_AT = new Date(Date.now() + 26 * 3600 * 1000);
const booking = (over = {}) => ({
  id: 'f1', tenant_id: 't1', lead_id: 'l1', followup_type: 'visit', next_followup_at: BOOKING_AT, meeting_url: null,
  lead_name: 'Priya', phone: '+918980235151', assigned_to: null, opted_out: false,
  tenant_name: 'Salonox', tenant_address: 'MG Road', tenant_city: 'Baramati',
  settings: { whatsapp_business_account_id: 'w', whatsapp_access_token: 'x', booking_messages: { visit_confirmation_template: 'visit_confirmation' } },
  ...over,
});

// Fake DB: answers the service's queries by statement, records what was written.
function setup({ row = booking(), sessionOpen = false, claimed = true, templates = [] } = {}) {
  const writes = [];
  const sends = [];
  const query = async (sql, params) => {
    if (/FROM lead_followups f\s+JOIN leads/.test(sql)) return { rows: [row] };
    if (/INSERT INTO booking_messages/.test(sql)) return { rows: claimed ? [{ id: 'c1' }] : [] };
    if (/whatsapp_template_media/.test(sql)) return { rows: [] };
    writes.push({ sql, params });
    return { rows: [] };
  };
  const svc = load('services/bookingMessages.js', {
    '../config/db': { query },
    './whatsappService': {
      sendTextMessage: async (to, message) => { sends.push({ kind: 'text', to, message }); return { success: true, wa_message_id: 'w1' }; },
      sendTemplate: async (to, name, lang, parameters) => { sends.push({ kind: 'template', to, name, lang, parameters }); return { success: true, wa_message_id: 'w2' }; },
      listMessageTemplates: async () => ({ success: true, templates }),
    },
    '../utils/whatsappCredentials': { resolveWhatsAppCredentials: async () => null },
    '../utils/sessionWindow': { isSessionOpen: async () => sessionOpen },
    './whatsappConsent': { checkTemplateConsent: async () => ({ allowed: true }) },   // a booking = asked to be contacted
  });
  return { svc, writes, sends };
}

const VISIT_TEMPLATE = {
  name: 'visit_confirmation', language: 'en_US', status: 'APPROVED',
  components: [{ type: 'BODY', text: 'Hi {{1}}, your visit to {{2}} is confirmed for {{3}}.\n\n📍 {{4}}\nDirections: {{5}}\n\nReply to reschedule.' }],
};

test('outside the 24h window, the approved template is sent with name, business, time, address and maps link', async () => {
  const { svc, sends, writes } = setup({ templates: [VISIT_TEMPLATE] });
  const result = await svc.sendBookingMessage('f1', 'confirmation');
  assert.equal(result.sent, true);
  assert.equal(result.via, 'template');
  assert.equal(sends.length, 1);
  const [send] = sends;
  assert.equal(send.name, 'visit_confirmation');
  assert.equal(send.lang, 'en_US');
  const values = send.parameters.map(p => p.text);
  assert.equal(values.length, 5);
  assert.equal(values[0], 'Priya');
  assert.equal(values[1], 'Salonox');
  assert.match(values[2], / at \d{1,2}:\d{2} (AM|PM)$/);
  assert.equal(values[3], 'MG Road, Baramati');
  assert.equal(values[4], 'https://maps.google.com/?q=MG%20Road%2C%20Baramati');
  assert.ok(writes.some(w => /INSERT INTO whatsapp_messages/.test(w.sql) && w.params[2].includes('Priya')), 'logged to the inbox');
  assert.ok(writes.some(w => /UPDATE booking_messages/.test(w.sql) && w.params[1] === 'sent'));
});

test('inside the 24h window a free-text message is sent instead of the template', async () => {
  const { svc, sends } = setup({ sessionOpen: true, row: booking({ followup_type: 'demo', meeting_url: 'https://meet.google.com/abc' }) });
  const result = await svc.sendBookingMessage('f1', 'confirmation');
  assert.equal(result.via, 'text');
  assert.match(sends[0].message, /demo with \*Salonox\* is confirmed/);
  assert.match(sends[0].message, /https:\/\/meet\.google\.com\/abc/);
});

test('no template and no open window fails with a clear reason; nothing is sent', async () => {
  const { svc, sends } = setup({ row: booking({ settings: {} }) });
  const result = await svc.sendBookingMessage('f1', 'confirmation');
  assert.equal(result.sent, false);
  assert.match(result.error, /no approved template is selected/);
  assert.equal(sends.length, 0);
});

test('an already-claimed message is never sent twice', async () => {
  const { svc, sends } = setup({ claimed: false, templates: [VISIT_TEMPLATE] });
  const result = await svc.sendBookingMessage('f1', 'reminder_1');
  assert.equal(result.status, 'duplicate');
  assert.equal(sends.length, 0);
});

test('opted-out leads and non-appointment follow-ups are skipped', async () => {
  let { svc, sends } = setup({ row: booking({ opted_out: true }), templates: [VISIT_TEMPLATE] });
  assert.equal((await svc.sendBookingMessage('f1', 'confirmation')).status, 'skipped');
  ({ svc, sends } = setup({ row: booking({ followup_type: 'call' }) }));
  assert.equal((await svc.sendBookingMessage('f1', 'confirmation')).status, 'skipped');
  assert.equal(sends.length, 0);
});

test('reminder times read as today/tomorrow in the workspace timezone', () => {
  const { svc } = setup();
  const tz = 'Asia/Kolkata';
  assert.match(svc.whenText(new Date(Date.now() + 864e5), tz, true), /^tomorrow at \d{1,2}:\d{2} (AM|PM)$/);
  assert.match(svc.whenText(new Date(Date.now() + 5 * 864e5), tz, true), /^on \w{3}, \d{1,2} \w{3} at /);
  assert.match(svc.whenText(new Date('2026-10-03T05:30:00Z'), tz), /^Sat, 3 Oct at 11:00 AM$/);
});

test('reminder job: sends when due, skips late bookings, too-late ticks and disabled slots', async () => {
  const now = Date.now(), min = 60 * 1000;
  const cfg = { reminders_enabled: true, reminder_1_minutes: 1440, reminder_2_minutes: 120 };
  const rows = [
    // 2h reminder due 5 min ago, booked days earlier → reminder_2 only
    { id: 'due', next_followup_at: new Date(now + 115 * min), created_at: new Date(now - 3 * 864e5), cfg },
    // booked 2h05m ahead, just now → 2h reminder would follow the confirmation within minutes → skipped
    { id: 'fresh', next_followup_at: new Date(now + 115 * min), created_at: new Date(now - 10 * min), cfg },
    // 1-day reminder was due 3h ago (server down / booked late) → skipped, not sent late
    { id: 'late', next_followup_at: new Date(now + 21 * 60 * min), created_at: new Date(now - 3 * 864e5), cfg },
    // reminder_2 switched off
    { id: 'off', next_followup_at: new Date(now + 115 * min), created_at: new Date(now - 3 * 864e5), cfg: { ...cfg, reminder_2_minutes: 0 } },
  ];
  const sent = [];
  const job = load('jobs/bookingReminders.js', {
    '../config/db': { query: async () => ({ rows }) },
    '../services/followupSummary': { active: 'true' },
    '../services/bookingMessages': {
      bookingSettings: s => ({ reminder_1_minutes: 1440, reminder_2_minutes: 120, ...(s.booking_messages || {}) }),
      sendBookingMessage: async (id, kind) => { sent.push(`${id}:${kind}`); return { sent: true }; },
    },
  });
  await job.runBookingReminders();
  assert.deepEqual(sent, ['due:reminder_2']);
});
