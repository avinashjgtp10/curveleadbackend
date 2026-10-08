const { query } = require('../config/db');

// Who may receive a WhatsApp template (Batch 1 C). One rule for every template send —
// broadcasts, scheduled broadcasts, automation sequences, the inbox, inbound auto-replies
// and booking messages:
//  * MARKETING (and unknown category): only leads with a recorded opt-in
//    (whatsapp_opt_in_at + whatsapp_opt_in_source) who haven't opted out.
//  * UTILITY / AUTHENTICATION: opted-in leads, or leads who asked to be contacted — they came
//    in through a lead form, website or API, messaged the business, or booked a demo/visit.
// A contact messaging first counts as asking to be contacted, never as a marketing opt-in.

const REQUESTED_SOURCES = new Set(['meta_ads', 'google_ads', 'website', 'api', 'whatsapp', 'instagram', 'walkin']);

const templateCategory = (template) => {
  const c = String(template?.category || '').toUpperCase();
  return ['UTILITY', 'AUTHENTICATION'].includes(c) ? c : 'MARKETING';
};

// Pure decision. signals: { hasInbound, hasBooking } (only needed for utility templates).
const decideConsent = ({ lead, category, hasInbound = false, hasBooking = false }) => {
  if (lead.opted_out) return { allowed: false, reason: 'This lead has opted out of WhatsApp messages.' };
  const optedIn = !!lead.whatsapp_opt_in_at;
  if (category === 'MARKETING') {
    return optedIn ? { allowed: true } : { allowed: false, reason: 'No WhatsApp marketing opt-in on record for this lead.' };
  }
  if (optedIn || REQUESTED_SOURCES.has(lead.source) || hasInbound || hasBooking) return { allowed: true };
  return { allowed: false, reason: "This lead hasn't opted in or asked to be contacted, so only they can start the conversation." };
};

const checkTemplateConsent = async ({ tenantId, leadId, template, db = { query } }) => {
  const lead = (await db.query('SELECT id, source, opted_out, whatsapp_opt_in_at FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, tenantId])).rows[0];
  if (!lead) return { allowed: false, reason: 'Lead not found.' };
  const category = templateCategory(template);
  let signals = {};
  if (category !== 'MARKETING' && !lead.opted_out && !lead.whatsapp_opt_in_at && !REQUESTED_SOURCES.has(lead.source)) {
    const r = (await db.query(
      `SELECT EXISTS (SELECT 1 FROM whatsapp_messages WHERE tenant_id = $1 AND lead_id = $2 AND direction = 'inbound') AS has_inbound,
              EXISTS (SELECT 1 FROM lead_followups WHERE tenant_id = $1 AND lead_id = $2 AND lower(followup_type) IN ('demo','visit')) AS has_booking`,
      [tenantId, leadId])).rows[0];
    signals = { hasInbound: r.has_inbound, hasBooking: r.has_booking };
  }
  return { ...decideConsent({ lead, category, ...signals }), category };
};

// Records an opt-in (never overrides an earlier one, never re-subscribes an opted-out lead
// unless they explicitly asked again — pass resubscribe for START/SUBSCRIBE).
const recordOptIn = ({ tenantId, leadId, source, at = new Date(), resubscribe = false, db = { query } }) => db.query(
  `UPDATE leads SET whatsapp_opt_in_at = COALESCE(whatsapp_opt_in_at, $3), whatsapp_opt_in_source = COALESCE(whatsapp_opt_in_source, $4)
     ${resubscribe ? ', opted_out = false, opted_out_at = NULL' : ''}
   WHERE tenant_id = $1 AND id = $2 ${resubscribe ? '' : 'AND opted_out = false'}`,
  [tenantId, leadId, at, source]
);

// Sequences stopped for lack of an opt-in pick up where they left off once the lead opts in.
const resumeBlockedEnrollments = ({ tenantId, leadIds, db = { query } }) => db.query(
  `UPDATE automation_enrollments SET status = 'active', cancelled_at = NULL, cancelled_reason = NULL, blocked_reason=NULL,last_error=NULL, next_send_at = NOW()
   WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[]) AND ((status = 'cancelled' AND cancelled_reason = 'blocked_no_opt_in') OR (status='blocked' AND blocked_reason='blocked_no_opt_in'))`,
  [tenantId, leadIds]
);

module.exports = { REQUESTED_SOURCES, templateCategory, decideConsent, checkTemplateConsent, recordOptIn, resumeBlockedEnrollments };
