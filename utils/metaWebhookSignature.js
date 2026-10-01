const crypto = require("crypto");
function verifyMetaWebhook(body, signature, secret) {
  if (
    !Buffer.isBuffer(body) ||
    typeof signature !== "string" ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature) ||
    !secret
  )
    return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  return crypto.timingSafeEqual(
    expected,
    Buffer.from(signature.slice(7), "hex"),
  );
}
// Workspaces may connect WhatsApp through their own Meta app, and Meta signs
// each webhook with that app's secret. META_APP_SECRET is the platform app;
// META_EXTRA_APP_SECRETS is an optional comma-separated list of the others.
function webhookSecrets(env = process.env) {
  return [env.META_APP_SECRET, ...(env.META_EXTRA_APP_SECRETS || "").split(",")]
    .map((s) => (s || "").trim())
    .filter(Boolean);
}
function verifyMetaWebhookAny(body, signature, secrets) {
  return secrets.some((secret) => verifyMetaWebhook(body, signature, secret));
}
module.exports = { verifyMetaWebhook, verifyMetaWebhookAny, webhookSecrets };
