const crypto = require("crypto"),
  dns = require("dns").promises,
  https = require("https"),
  net = require("net");
const { query } = require("../config/db");
const { encryptSecret, decryptSecret } = require("../utils/cryptoSecrets");
const { EVENTS } = require("./features");
function publicAddress(address) {
  if (net.isIP(address) !== 4) return false; // Restrict outbound destinations to public IPv4, including DNS resolution.
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
async function resolveDestination(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Use a public HTTPS webhook URL."), {
      status: 422,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw Object.assign(
      new Error("Use HTTPS on port 443 without credentials."),
      { status: 422 },
    );
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw Object.assign(
      new Error("Webhook destination must resolve to public IPv4 addresses."),
      { status: 422 },
    );
  return { url, address: addresses[0].address };
}
const signature = (secret, timestamp, body) =>
  crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
async function createWebhook(tenantId, { url, events }) {
  await resolveDestination(url);
  if (
    !Array.isArray(events) ||
    !events.length ||
    events.some((e) => !EVENTS.includes(e))
  )
    throw Object.assign(new Error("Select valid webhook events."), {
      status: 422,
    });
  const secret = crypto.randomBytes(32).toString("hex");
  const row = (
    await query(
      "INSERT INTO outgoing_webhooks(tenant_id,url,secret,events) VALUES($1,$2,$3,$4) RETURNING id,url,events,active",
      [tenantId, url, encryptSecret(secret), events],
    )
  ).rows[0];
  return { ...row, secret };
}
async function postWebhook(urlValue, body, secret, id) {
  const { url, address } = await resolveDestination(urlValue);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        lookup: (_host, _options, cb) => cb(null, address, 4),
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-CurveLead-Delivery": id,
          "X-CurveLead-Timestamp": timestamp,
          "X-CurveLead-Signature": `sha256=${signature(secret, timestamp, body)}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Webhook timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
async function runWebhooks() {
  for (let i = 0; i < 50; i++) {
    const d = (
      await query(`UPDATE webhook_deliveries SET attempts=attempts+1,next_attempt_at=now()+interval '2 minutes'
 WHERE id=(SELECT d.id FROM webhook_deliveries d JOIN outgoing_webhooks w ON w.id=d.webhook_id WHERE d.status='pending' AND d.next_attempt_at<=now() AND w.active ORDER BY d.next_attempt_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED) RETURNING *`)
    ).rows[0];
    if (!d) break;
    const w = (
      await query(
        "SELECT * FROM outgoing_webhooks WHERE id=$1 AND tenant_id=$2 AND active",
        [d.webhook_id, d.tenant_id],
      )
    ).rows[0];
    if (!w) continue;
    let code = null,
      error = null;
    try {
      code = await postWebhook(
        w.url,
        JSON.stringify({ ...d.payload, id: d.id }),
        decryptSecret(w.secret),
        d.id,
      );
      if (code < 200 || code >= 300) error = `HTTP ${code}`;
    } catch (e) {
      error = e.message.slice(0, 200);
    }
    await query(
      `UPDATE webhook_deliveries SET status=$2,response_code=$3,error=$4,delivered_at=CASE WHEN $2='delivered' THEN now() END,next_attempt_at=now()+($5::int*interval '1 minute') WHERE id=$1`,
      [
        d.id,
        error ? (d.attempts >= 5 ? "failed" : "pending") : "delivered",
        code,
        error,
        2 ** d.attempts,
      ],
    );
  }
}
module.exports = {
  publicAddress,
  resolveDestination,
  signature,
  createWebhook,
  postWebhook,
  runWebhooks,
};
