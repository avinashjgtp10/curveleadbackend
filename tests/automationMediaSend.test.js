// Runs the real sequence runner against a scripted in-memory database to prove how a step
// with a file is sent: file + caption inside the 24h window, template outside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunner } = require('../jobs/automationSequenceRunner');

const ATTACHMENT = { url: 'https://b.s3.us-east-1.amazonaws.com/sequence-media/t1/1-a.pdf', name: 'prices.pdf', type: 'document', size: 10, mime: 'application/pdf' };
const SETTINGS = { whatsapp_phone_number_id: 'p1', whatsapp_access_token: 'tok', whatsapp_business_account_id: 'w1' };
const TEMPLATE = { name: 'hello', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] };

function harness({ step, lastInboundHoursAgo }) {
  const log = { inserts: [], activities: [], media: [], text: [], template: [] };
  let token = null;
  const lastInbound = lastInboundHoursAgo == null ? null : new Date(Date.now() - lastInboundHoursAgo * 3600 * 1000);
  const stepRow = { id: 'step-1', tenant_id: 't1', sequence_id: 'seq-1', step_order: 0, delay_minutes: 0, channel: 'whatsapp', message: '', reply_routes: [], template_parameters: [], ...step };
  const lead = { id: 'lead-1', tenant_id: 't1', name: 'Asha', phone: '919999900000', ai_paused: false, last_inbound: lastInbound, tenant_settings: SETTINGS, tenant_name: 'Shop', source: 'website', is_won: false, is_lost: false };
  const answer = (sql, args) => {
    if (sql.includes('WITH due AS')) { token = args[0]; return { rows: [{ id: 'enr-1', enrollment_id: 'enr-1', tenant_id: 't1', lead_id: 'lead-1', sequence_id: 'seq-1', current_step: 0 }] }; }
    if (sql.includes('FROM leads l JOIN tenants t')) return { rows: [lead] };
    if (sql.includes('FROM automation_sequence_steps')) return { rows: [stepRow] };
    if (sql.includes('INSERT INTO automation_send_attempts')) return { rows: [{ id: 'att-1', status: 'ready', attempts: 0 }] };
    if (sql.includes("SET status='sending'")) return { rows: [{ id: 'att-1' }] };
    if (sql.includes('FROM whatsapp_template_media')) return { rows: [] };
    if (sql.includes('FROM leads l LEFT JOIN LATERAL')) return { rows: [lead] };
    if (sql.includes('FROM automation_enrollments e JOIN automation_sequences')) return { rows: [{ id: 'enr-1', tenant_id: 't1', lead_id: 'lead-1', sequence_id: 'seq-1', current_step: 0, status: 'active', claim_token: token, sequence_active: true, stop_conditions: {}, tenant_settings: SETTINGS, tenant_name: 'Shop', enrolled_at: new Date() }] };
    if (sql.includes('INSERT INTO whatsapp_messages')) log.inserts.push(args);
    if (sql.includes('INSERT INTO lead_activities')) log.activities.push(args);
    return { rows: [] };
  };
  const db = { query: async (sql, args) => answer(sql, args), transaction: async (fn) => fn({ query: async (sql, args) => answer(sql, args) }) };
  const deps = {
    db,
    listMessageTemplates: async () => ({ success: true, templates: [TEMPLATE] }),
    getPresignedUrl: async (u) => `${u}?signed=1`,
    sendMediaMessage: async (...a) => { log.media.push(a); return { success: true, wa_message_id: 'wamid.media' }; },
    sendTextMessage: async (...a) => { log.text.push(a); return { success: true, wa_message_id: 'wamid.text' }; },
    sendTemplate: async (...a) => { log.template.push(a); return { success: true, wa_message_id: 'wamid.tpl' }; },
  };
  return { run: createRunner(deps), log };
}

test('inside the 24h window the file is sent with the step text as its caption', async () => {
  const { run, log } = harness({ step: { message: 'Hi {{name}}, prices attached', media: [ATTACHMENT] }, lastInboundHoursAgo: 2 });
  await run();
  assert.equal(log.media.length, 1);
  assert.equal(log.text.length, 0, 'no separate text message');
  const [to, kind, url, caption, creds, filename] = log.media[0];
  assert.equal(to, '919999900000');
  assert.equal(kind, 'doc');
  assert.equal(url, `${ATTACHMENT.url}?signed=1`, 'Meta gets a signed link');
  assert.equal(caption, 'Hi Asha, prices attached', 'the caption is the step text with the lead\'s name filled in');
  assert.equal(creds.phone_number_id, 'p1');
  assert.equal(filename, 'prices.pdf', 'the document keeps its own file name, not the caption');
  // the sent message is recorded with its media
  const saved = log.inserts[0];
  assert.equal(saved[3], 'document');
  assert.equal(saved[4], ATTACHMENT.url);
});

test('a file-only step (no text) is sent with an empty caption and logged under its file name', async () => {
  const { run, log } = harness({ step: { message: '', media: [{ ...ATTACHMENT, type: 'image', name: 'offer.png' }] }, lastInboundHoursAgo: 1 });
  await run();
  assert.equal(log.media[0][1], 'image');
  assert.equal(log.media[0][3], '');
  assert.equal(log.inserts[0][2], 'offer.png');
});

test('outside the window the approved template is sent and the file is skipped, with a note', async () => {
  const { run, log } = harness({ step: { message: 'Hi', media: [ATTACHMENT], approved_template_name: 'hello', template_language: 'en_US' }, lastInboundHoursAgo: 48 });
  await run();
  assert.equal(log.media.length, 0, 'WhatsApp would reject a file here');
  assert.equal(log.template.length, 1);
  assert.ok(log.activities.some(a => a[2] === 'Attachment not sent' && /prices\.pdf/.test(a[3])), 'the timeline says why');
});

test('a plain text step is unchanged', async () => {
  const { run, log } = harness({ step: { message: 'just text', media: [] }, lastInboundHoursAgo: 1 });
  await run();
  assert.equal(log.text.length, 1);
  assert.equal(log.media.length, 0);
  assert.equal(log.inserts[0][3], 'text');
  assert.equal(log.inserts[0][4], null);
});
