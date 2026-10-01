const { query } = require("../config/db");
const { isWithinBusinessHours } = require("../utils/businessHours");
const { isSessionOpen } = require("../utils/sessionWindow");
const { resolveWhatsAppCredentials } = require("../utils/whatsappCredentials");
const {
  sendTextMessage,
  sendTemplate,
  listMessageTemplates,
} = require("./whatsappService");
const { substituteVars } = require("../utils/templateVars");
function matchReply(rules, { text, first, outside }) {
  return (rules || []).find(
    (r) =>
      r.enabled !== false &&
      ((r.trigger === "keyword" &&
        text.toLocaleLowerCase().includes(r.keyword.toLocaleLowerCase())) ||
        (r.trigger === "first_message" && first) ||
        (r.trigger === "outside_hours" && outside)),
  );
}
async function replyToInbound({ lead, text, messageId, settings }) {
  if (lead.ai_paused || lead.opted_out) return false;
  const first =
    Number(
      (
        await query(
          "SELECT count(*) n FROM whatsapp_messages WHERE tenant_id=$1 AND lead_id=$2 AND direction='inbound'",
          [lead.tenant_id, lead.id],
        )
      ).rows[0].n,
    ) === 1;
  const rule = matchReply(settings.inbound_reply_rules, {
    text,
    first,
    outside: !isWithinBusinessHours(settings.whatsapp_business_hours),
  });
  if (!rule) return false;
  if (rule.type === "text" && !(await isSessionOpen(lead.id))) return false;
  const claim = await query(
    "INSERT INTO inbound_reply_claims(tenant_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING message_id",
    [lead.tenant_id, messageId],
  );
  if (!claim.rows.length) return true;
  const credentials = await resolveWhatsAppCredentials(
    lead.tenant_id,
    lead.assigned_to,
  );
  let result,
    body = substituteVars(rule.value, lead);
  if (rule.type === "template") {
    const list = await listMessageTemplates(
      settings.whatsapp_business_account_id,
      settings.whatsapp_access_token,
    );
    const template = list.templates?.find(
      (t) =>
        t.name === rule.value &&
        t.language === (rule.language || "en_US") &&
        t.status === "APPROVED",
    );
    const raw = template?.components?.find((c) => c.type === "BODY")?.text;
    if (
      !raw ||
      /\{\{/.test(raw) ||
      template.components.some((c) => c.type === "HEADER")
    )
      return false;
    body = raw;
    result = await sendTemplate(
      lead.phone,
      rule.value,
      rule.language || "en_US",
      [],
      credentials,
    );
  } else result = await sendTextMessage(lead.phone, body, credentials);
  await query(
    `INSERT INTO whatsapp_messages(tenant_id,lead_id,direction,message,message_type,template_name,wa_message_id,status,is_automated) VALUES($1,$2,'outbound',$3,$4,$5,$6,$7,true)`,
    [
      lead.tenant_id,
      lead.id,
      body,
      rule.type,
      rule.type === "template" ? rule.value : null,
      result.wa_message_id || null,
      result.success ? "sent" : "failed",
    ],
  );
  return true;
}
module.exports = { matchReply, replyToInbound };
