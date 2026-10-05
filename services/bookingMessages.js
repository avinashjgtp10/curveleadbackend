const { query } = require('../config/db');
const { sendTextMessage, sendTemplate, listMessageTemplates } = require('./whatsappService');
const { resolveWhatsAppCredentials } = require('../utils/whatsappCredentials');
const { isSessionOpen } = require('../utils/sessionWindow');
const { checkTemplateConsent } = require('./whatsappConsent');

// WhatsApp messages to the lead about a demo/visit booking: a confirmation when it's
// booked, and up to two reminders before it. Inside the 24h customer-service window a
// free-text message is sent; outside it, the approved template picked in
// WhatsApp → Automation → Booking messages. Template variables are filled by position:
//   demo:  {{1}} lead name · {{2}} business · {{3}} date & time · {{4}} meeting link
//   visit: {{1}} lead name · {{2}} business · {{3}} date & time · {{4}} address · {{5}} maps link

const BOOKING_TYPES = ['demo', 'visit'];
const KINDS = ['confirmation', 'reminder_1', 'reminder_2'];
const DEFAULTS = {
  confirmation_enabled: true,
  reminders_enabled: false,
  reminder_1_minutes: 1440,
  reminder_2_minutes: 120,
  address: '',
  maps_url: '',
  demo_confirmation_template: '',
  visit_confirmation_template: '',
  demo_reminder_template: '',
  visit_reminder_template: '',
};
const VARIABLES = {
  demo: ['name', 'business', 'when', 'meeting_url'],
  visit: ['name', 'business', 'when', 'address', 'maps_url'],
};

const bookingSettings = (settings) => ({ ...DEFAULTS, ...(settings?.booking_messages || {}) });

const validTimezone = (tz) => {
  try { new Intl.DateTimeFormat('en-IN', { timeZone: tz }); return tz; } catch { return 'Asia/Kolkata'; }
};
const dayKey = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

// "Fri, 3 Oct at 11:00 AM"; with `relative`, "today at …" / "tomorrow at …" / "on Fri, 3 Oct at …".
const whenText = (at, tz, relative = false) => {
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(at).replace(/\s/g, ' ').toUpperCase();
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(at);
  if (!relative) return `${day} at ${time}`;
  const key = dayKey(at, tz);
  if (key === dayKey(new Date(), tz)) return `today at ${time}`;
  if (key === dayKey(new Date(Date.now() + 864e5), tz)) return `tomorrow at ${time}`;
  return `on ${day} at ${time}`;
};

const bookingValues = (row, cfg, kind) => {
  const tz = validTimezone(row.settings?.timezone || 'Asia/Kolkata');
  const address = (cfg.address || [row.tenant_address, row.tenant_city].filter(Boolean).join(', ')).trim();
  return {
    name: (row.lead_name || '').trim() || 'there',
    business: row.tenant_name || 'us',
    when: whenText(new Date(row.next_followup_at), tz, kind !== 'confirmation'),
    meeting_url: row.meeting_url || '',
    address,
    maps_url: cfg.maps_url || (address ? `https://maps.google.com/?q=${encodeURIComponent(address)}` : ''),
  };
};

const freeText = (type, kind, v) => {
  const what = type === 'demo' ? `demo with *${v.business}*` : `visit to *${v.business}*`;
  let msg = kind === 'confirmation'
    ? `Hi ${v.name}, your ${what} is confirmed for *${v.when}*.`
    : `Hi ${v.name}, a quick reminder of your ${what} *${v.when}*.`;
  if (type === 'demo' && v.meeting_url) msg += `\n\nJoin the meeting here: ${v.meeting_url}`;
  if (type === 'visit' && v.address) msg += `\n\n📍 ${v.address}`;
  if (type === 'visit' && v.maps_url) msg += `${v.address ? '\n' : '\n\n'}Directions: ${v.maps_url}`;
  return `${msg}\n\nReply to this message if you need to reschedule.`;
};

// Variables Meta can't take empty — say something sensible instead of failing the send.
const FALLBACKS = { meeting_url: "we'll share the link shortly", address: "we'll share the address shortly", maps_url: "we'll share directions shortly" };

const templateVarCount = (text) => Math.max(0, ...[...(text || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])));

// Resolves the approved template (name → language + body) from the workspace's WABA.
const findApprovedTemplate = async (settings, name) => {
  const list = await listMessageTemplates(settings.whatsapp_business_account_id, settings.whatsapp_access_token).catch(() => null);
  if (!list?.success) return { error: 'Could not load WhatsApp templates from Meta.' };
  const t = list.templates.find(x => x.name === name && x.status === 'APPROVED');
  if (!t) return { error: `Template "${name}" is not approved (or no longer exists) in WhatsApp Manager.` };
  return { template: t, body: t.components?.find(c => c.type === 'BODY')?.text || '' };
};

const loadBooking = async (followupId) => (await query(
  `SELECT f.id, f.tenant_id, f.lead_id, f.followup_type, f.next_followup_at, f.meeting_url,
          l.name AS lead_name, l.phone, l.assigned_to, l.opted_out,
          t.name AS tenant_name, t.address AS tenant_address, t.city AS tenant_city, t.settings
   FROM lead_followups f
   JOIN leads l ON l.id = f.lead_id AND l.tenant_id = f.tenant_id
   JOIN tenants t ON t.id = f.tenant_id
   WHERE f.id = $1`, [followupId]
)).rows[0];

// Claims (followup, kind, booking time) so a message is never sent twice. Returns
// the claim id, null if it was already claimed, or 'untracked' when the migration
// hasn't been run yet (confirmations still go out; reminders need the table).
const claim = async (row, kind) => {
  try {
    const r = await query(
      `INSERT INTO booking_messages (tenant_id, followup_id, kind, booking_at)
       SELECT tenant_id, id, $2, next_followup_at FROM lead_followups WHERE id = $1
       ON CONFLICT (followup_id, kind, booking_at) DO NOTHING RETURNING id`, [row.id, kind]
    );
    return r.rows[0]?.id || null;
  } catch (e) {
    if (e.code === '42P01') return 'untracked';
    throw e;
  }
};

const finish = (claimId, status, via, error) => claimId && claimId !== 'untracked'
  ? query('UPDATE booking_messages SET status = $2, via = $3, error = $4 WHERE id = $1', [claimId, status, via || null, error || null]).catch(() => {})
  : Promise.resolve();

const logActivity = (row, kind, sent, description) => query(
  `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description)
   VALUES ($1, $2, $3, $4, $5)`,
  [row.tenant_id, row.lead_id, kind === 'confirmation' ? 'booking_confirmation' : 'booking_reminder',
    `Booking ${kind === 'confirmation' ? 'confirmation' : 'reminder'} ${sent ? 'sent' : 'not sent'} on WhatsApp`, description]
).catch(() => {});

/**
 * Sends the confirmation or a reminder for one demo/visit booking.
 * @returns {Promise<{ sent: boolean, status: string, via?: string, error?: string }>}
 */
const sendBookingMessage = async (followupId, kind) => {
  if (!KINDS.includes(kind)) throw new Error(`Unknown booking message kind: ${kind}`);
  const row = await loadBooking(followupId);
  const type = (row?.followup_type || '').toLowerCase();
  if (!row || !BOOKING_TYPES.includes(type) || !row.next_followup_at) return { sent: false, status: 'skipped', error: 'Not a demo/visit booking.' };

  const claimId = await claim(row, kind);
  if (!claimId) return { sent: false, status: 'duplicate' };

  const skip = async (error) => {
    await finish(claimId, 'skipped', null, error);
    await logActivity(row, kind, false, error);
    return { sent: false, status: 'skipped', error };
  };
  if (!row.phone) return skip('Lead has no phone number.');
  if (row.opted_out) return skip('Lead has opted out of WhatsApp messages.');

  try {
    const settings = row.settings || {};
    const cfg = bookingSettings(settings);
    const v = bookingValues(row, cfg, kind);
    const credentials = await resolveWhatsAppCredentials(row.tenant_id, row.assigned_to);
    const templateName = cfg[`${type}_${kind === 'confirmation' ? 'confirmation' : 'reminder'}_template`];

    let via, message, result, templateUsed = null;
    if (await isSessionOpen(row.lead_id)) {
      via = 'text';
      message = freeText(type, kind, v);
      result = await sendTextMessage(row.phone, message, credentials);
    } else if (templateName) {
      const found = await findApprovedTemplate(settings, templateName);
      if (found.error) throw new Error(found.error);
      const consent = await checkTemplateConsent({ tenantId: row.tenant_id, leadId: row.lead_id, template: found.template });
      if (!consent.allowed) return skip(consent.reason);
      const needed = templateVarCount(found.body);
      const keys = VARIABLES[type];
      if (needed > keys.length) throw new Error(`Template "${templateName}" has ${needed} variables; a ${type} message can fill at most ${keys.length}.`);
      const parameters = keys.slice(0, needed).map(k => ({ type: 'text', text: String(v[k] || FALLBACKS[k] || '-') }));
      const media = (await query(
        'SELECT media_type, media_url FROM whatsapp_template_media WHERE tenant_id = $1 AND template_name = $2 AND language = $3',
        [row.tenant_id, templateName, found.template.language]
      ).catch(() => ({ rows: [] }))).rows[0];
      via = 'template';
      templateUsed = templateName;
      message = found.body.replace(/\{\{(\d+)\}\}/g, (m, n) => parameters[Number(n) - 1]?.text ?? m);
      result = await sendTemplate(row.phone, templateName, found.template.language, parameters, credentials,
        media ? { type: media.media_type.toLowerCase(), link: media.media_url } : null);
    } else {
      throw new Error("Outside WhatsApp's 24-hour window and no approved template is selected in WhatsApp → Automation → Booking messages.");
    }

    await query(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, template_name, wa_message_id, status, is_automated)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, true)`,
      [row.tenant_id, row.lead_id, message, via === 'template' ? 'template' : 'text', templateUsed,
        result.wa_message_id || null, result.success ? 'sent' : 'failed']
    ).catch(() => {});

    if (!result.success) throw new Error(result.error || 'WhatsApp send failed.');
    await finish(claimId, 'sent', via);
    await logActivity(row, kind, true, message);
    return { sent: true, status: 'sent', via };
  } catch (e) {
    await finish(claimId, 'failed', null, e.message.slice(0, 500));
    await logActivity(row, kind, false, e.message);
    return { sent: false, status: 'failed', error: e.message };
  }
};

module.exports = {
  BOOKING_TYPES, DEFAULTS, VARIABLES, bookingSettings, whenText, bookingValues, freeText, templateVarCount, sendBookingMessage,
  findApprovedTemplate,
};
