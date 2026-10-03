const axios = require("axios");
const { query } = require("../config/db");
const { healthState } = require("../services/features");
const { runWebhooks } = require("../services/outgoingWebhooks");
const { decryptSecret } = require("../utils/cryptoSecrets");
const { createNotification } = require("../controllers/notificationController");
const { GRAPH_URL } = require('../config/meta');
let running = false,
  lastHealth = 0;
async function checkHealth() {
  const tenants = (
    await query(
      "SELECT id,settings FROM tenants WHERE subscription_status IN ('active','trial')",
    )
  ).rows;
  for (const t of tenants) {
    const s = t.settings || {};
    const google = (
      await query(
        "SELECT webhook_key_encrypted FROM google_ads_integrations WHERE tenant_id=$1 AND is_active=true",
        [t.id],
      )
    ).rows;
    const providers = [
      ["facebook", s.meta_page_id, s.meta_page_access_token],
      ["whatsapp", s.whatsapp_phone_number_id, s.whatsapp_access_token],
      ["google_ads", google.length, null],
    ];
    for (const [provider, id, token] of providers) {
      if (!id && !token) continue;
      let valid = null;
      if (provider === "google_ads") {
        try {
          valid = google.every((g) => !!decryptSecret(g.webhook_key_encrypted));
        } catch {
          valid = false;
        }
      } else if (!token) valid = false;
      else
        try {
          await axios.get(
            `${GRAPH_URL}/${encodeURIComponent(id)}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              params: { fields: "id" },
              timeout: 10000,
            },
          );
          valid = true;
        } catch (e) {
          if (
            [190, 102].includes(e.response?.data?.error?.code) ||
            [401, 403].includes(e.response?.status)
          )
            valid = false;
        }
      const row = (
        await query(
          `INSERT INTO integration_health(tenant_id,provider,token_valid,checked_at) VALUES($1,$2,$3,now()) ON CONFLICT(tenant_id,provider) DO UPDATE SET token_valid=COALESCE(EXCLUDED.token_valid,integration_health.token_valid),checked_at=now() RETURNING *`,
          [t.id, provider, valid],
        )
      ).rows[0];
      const state = healthState(row, s.integration_alert_hours || 24);
      if (
        ["disconnected", "stale"].includes(state) &&
        (!row.alerted_at || Date.now() - new Date(row.alerted_at) > 86400000)
      ) {
        const name = {
          facebook: "Facebook",
          google_ads: "Google Ads",
          whatsapp: "WhatsApp",
        }[provider];
        const title =
          state === "disconnected"
            ? `${name} disconnected — leads are not syncing. Reconnect.`
            : `${name}: no leads received for ${s.integration_alert_hours || 24} hours. Check integration.`;
        const users = (
          await query(
            "SELECT id FROM users WHERE tenant_id=$1 AND role='admin' AND is_active=true",
            [t.id],
          )
        ).rows;
        for (const u of users)
          await createNotification(
            t.id,
            u.id,
            title,
            title,
            "integration_health",
            "integration",
            null,
          );
        await query(
          "UPDATE integration_health SET alerted_at=now() WHERE tenant_id=$1 AND provider=$2",
          [t.id, provider],
        );
      } else if (state === "healthy")
        await query(
          "UPDATE integration_health SET alerted_at=NULL WHERE tenant_id=$1 AND provider=$2",
          [t.id, provider],
        );
    }
  }
}
// Drains meta_capi_queue (filled by the phase4_lead_events trigger on stage changes).
// Errors retry with exponential backoff (2, 4, 8 … minutes, 6 attempts); a workspace with
// CAPI on but no dataset id / token fails at once with a clear reason instead of retrying.
const CAPI_MAX_ATTEMPTS = 6;
const CAPI_NOT_CONFIGURED = "Conversions API is on, but the dataset ID or access token is missing (Integrations → Meta Conversions API).";
async function runCapi() {
  for (let i = 0; i < 50; i++) {
    const event = (
      await query(
        `UPDATE meta_capi_queue SET attempts=attempts+1,next_attempt_at=now()+interval '2 minutes' WHERE id=(SELECT id FROM meta_capi_queue WHERE status='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
      )
    ).rows[0];
    if (!event) break;
    let status = "error", error = null;
    try {
      status = await require("../utils/metaCapi").sendLeadConversionEvent({
        tenantId: event.tenant_id,
        lead: event.lead_snapshot,
        eventName: event.event_name,
        eventTime: event.created_at,
      });
    } catch (e) {
      error = e.message;
      console.error("CAPI delivery:", e.message);
    }
    const next =
      status === "error" ? (event.attempts >= CAPI_MAX_ATTEMPTS ? "failed" : "pending")
      : status === "not_configured" ? "failed"
      : status;
    await query(
      `UPDATE meta_capi_queue SET status=$2, next_attempt_at=now()+($3::int*interval '1 minute'), last_error=$4,
         sent_at=CASE WHEN $2='success' THEN now() ELSE sent_at END
       WHERE id=$1`,
      [event.id, next, 2 ** event.attempts,
        status === "not_configured" ? CAPI_NOT_CONFIGURED : status === "error" ? (error || "Meta rejected the event — see meta_capi_events.") : null],
    );
  }
}
async function runFeatureJobs() {
  if (running) return;
  running = true;
  try {
    await runWebhooks();
    await runCapi();
    if (Date.now() - lastHealth > 15 * 60000) {
      await checkHealth();
      lastHealth = Date.now();
    }
  } finally {
    running = false;
  }
}
module.exports = { checkHealth, runFeatureJobs, runCapi };
