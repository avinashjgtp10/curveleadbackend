const crypto = require("crypto");
const { query, transaction } = require("../config/db");
const EVENTS = ["lead.created", "lead.stage_changed", "lead.won"];
const SETTING_KEYS = [
  "assignment_fallback_id",
  "integration_alert_hours",
  "meta_capi_enabled",
  "meta_qualified_event",
  "meta_won_event",
  "inbound_reply_rules",
  "canned_replies",
  "whatsapp_messaging_limit",
];
const fail = (message) => Object.assign(new Error(message), { status: 422 });
function validateSettings(input) {
  const out = Object.fromEntries(
    SETTING_KEYS.filter((k) => input[k] !== undefined).map((k) => [
      k,
      input[k],
    ]),
  );
  if (
    out.integration_alert_hours !== undefined &&
    (!Number.isInteger(out.integration_alert_hours) ||
      out.integration_alert_hours < 1 ||
      out.integration_alert_hours > 720)
  )
    throw fail("Alert threshold must be 1–720 hours.");
  if (
    out.whatsapp_messaging_limit !== undefined &&
    (!Number.isInteger(out.whatsapp_messaging_limit) ||
      out.whatsapp_messaging_limit < 1)
  )
    throw fail("Messaging limit must be a positive number.");
  if (
    out.assignment_fallback_id &&
    !/^[0-9a-f-]{36}$/i.test(out.assignment_fallback_id)
  )
    throw fail("Invalid fallback assignee.");
  if (
    out.meta_capi_enabled !== undefined &&
    typeof out.meta_capi_enabled !== "boolean"
  )
    throw fail("Invalid CAPI toggle.");
  for (const key of ["meta_qualified_event", "meta_won_event"])
    if (
      out[key] !== undefined &&
      !/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(out[key])
    )
      throw fail("Invalid conversion event name.");
  if (
    out.canned_replies !== undefined &&
    (!Array.isArray(out.canned_replies) ||
      out.canned_replies.length > 100 ||
      out.canned_replies.some(
        (r) =>
          typeof r.name !== "string" ||
          !r.name.trim() ||
          typeof r.text !== "string" ||
          !r.text.trim() ||
          r.text.length > 4096,
      ))
  )
    throw fail("Canned replies need a name and text (up to 4096 characters).");
  if (
    out.inbound_reply_rules !== undefined &&
    (!Array.isArray(out.inbound_reply_rules) ||
      out.inbound_reply_rules.length > 30 ||
      out.inbound_reply_rules.some(
        (r) =>
          !["keyword", "outside_hours", "first_message"].includes(r.trigger) ||
          !["text", "template"].includes(r.type) ||
          (r.trigger === "keyword" && !r.keyword?.trim()) ||
          !r.value?.trim() ||
          r.value.length > 4096,
      ))
  )
    throw fail("Invalid inbound reply rule.");
  return out;
}
async function getConfig(tenantId) {
  const s =
    (await query("SELECT settings FROM tenants WHERE id=$1", [tenantId]))
      .rows[0]?.settings || {};
  return {
    integration_alert_hours: 24,
    meta_capi_enabled: false,
    meta_qualified_event: "QualifiedLead",
    meta_won_event: "ConvertedLead",
    inbound_reply_rules: [],
    canned_replies: [],
    ...Object.fromEntries(
      SETTING_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]),
    ),
  };
}
async function saveConfig(tenantId, input) {
  const patch = validateSettings(input);
  if (
    patch.assignment_fallback_id &&
    !(
      await query(
        "SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND is_active=true",
        [tenantId, patch.assignment_fallback_id],
      )
    ).rows.length
  )
    throw fail("Fallback assignee must be active in this workspace.");
  await query(
    "UPDATE tenants SET settings=COALESCE(settings,'{}'::jsonb)||$2::jsonb WHERE id=$1",
    [tenantId, JSON.stringify(patch)],
  );
  return getConfig(tenantId);
}
function healthState(row, hours = 24, now = Date.now()) {
  if (row.token_valid === false) return "disconnected";
  if (
    now -
      new Date(row.last_lead_received_at || row.monitoring_since).getTime() >
    hours * 3600000
  )
    return "stale";
  return row.token_valid === true ? "healthy" : "unknown";
}
async function getHealth(tenantId) {
  const config = await getConfig(tenantId);
  return (
    await query(
      "SELECT * FROM integration_health WHERE tenant_id=$1 ORDER BY provider",
      [tenantId],
    )
  ).rows.map((r) => ({
    ...r,
    state: healthState(r, config.integration_alert_hours),
  }));
}
async function newContentLink({
  tenantId,
  leadId,
  kind,
  contentId,
  title,
  destination,
}) {
  const token = crypto.randomBytes(24).toString("hex");
  await query(
    "INSERT INTO content_links(token,tenant_id,lead_id,kind,content_id,title,destination) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [token, tenantId, leadId, kind, contentId, title, destination],
  );
  return `${process.env.API_BASE_URL || process.env.API_URL || "https://api.curvelead.com"}/api/features/content/${token}`;
}
async function viewContent(token) {
  return transaction(async (client) => {
    const r = (
      await client.query(
        "SELECT * FROM content_links WHERE token=$1 FOR UPDATE",
        [token],
      )
    ).rows[0];
    if (!r) return null;
    if (!r.first_viewed_at) {
      await client.query(
        "UPDATE content_links SET first_viewed_at=now() WHERE token=$1",
        [token],
      );
      const lead = (
        await client.query(
          "UPDATE leads SET lead_score=CASE WHEN lead_score='cold' THEN 'warm' ELSE 'hot' END WHERE id=$1 AND tenant_id=$2 RETURNING assigned_to",
          [r.lead_id, r.tenant_id],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO lead_activities(tenant_id,lead_id,activity_type,title) VALUES($1,$2,'content_view',$3)",
        [r.tenant_id, r.lead_id, `Viewed ${r.kind} ${r.title}`],
      );
      if (lead?.assigned_to)
        await client.query(
          `INSERT INTO notifications(tenant_id,user_id,title,message,type,reference_type,reference_id) VALUES($1,$2,$3,$3,'content_view','lead',$4)`,
          [
            r.tenant_id,
            lead.assigned_to,
            `Viewed ${r.kind} ${r.title}`,
            r.lead_id,
          ],
        );
    }
    return r.destination;
  });
}
module.exports = {
  EVENTS,
  SETTING_KEYS,
  validateSettings,
  getConfig,
  saveConfig,
  healthState,
  getHealth,
  newContentLink,
  viewContent,
};
