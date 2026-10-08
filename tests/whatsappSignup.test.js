const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");

// Loads the controller with stubbed DB and Meta Graph calls.
function setup(graph) {
  const calls = [], writes = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || "GET", path: u.pathname.replace(/^\/v[\d.]+/, ""), body: opts.body ? JSON.parse(opts.body) : null });
    const route = `${opts.method || "GET"} ${u.pathname.replace(/^\/v[\d.]+/, "")}`;
    return { json: async () => (graph[route] ? graph[route](u) : { error: { message: `unexpected ${route}` } }) };
  };
  const query = async (sql, params) => {
    writes.push({ sql, params });
    return { rows: sql.startsWith("SELECT settings") ? [{ settings: { whatsapp_auto_responder_enabled: true } }] : [] };
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../controllers/integrationController.js"), "utf8"), {
    module, console: { ...console, error() {} }, JSON, URL, fetch, Set, Map, Date, Promise, String, Number,
    process: { env: { META_APP_ID: "111", META_APP_SECRET: "s3cret" } },
    require: (k) => (k === "crypto" ? require("crypto") : k === "../config/db" ? { query } : k === "../config/meta" ? require("../config/meta") : {}),
  });
  return { ctrl: module.exports, calls, writes };
}
const response = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });
const req = (body) => ({ tenantId: "t1", body });

test("embedded signup exchanges the code, subscribes the WABA, registers a new number and saves settings", async () => {
  const { ctrl, calls, writes } = setup({
    "GET /oauth/access_token": (u) => (u.searchParams.get("code") === "abc" && u.searchParams.get("client_secret") === "s3cret" ? { access_token: "biz-token" } : { error: { message: "bad code" } }),
    "GET /5550001/phone_numbers": () => ({ data: [{ id: "7770001", display_phone_number: "+91 90000 00000", verified_name: "Acme", platform_type: "NOT_APPLICABLE" }] }),
    "POST /5550001/subscribed_apps": () => ({ success: true }),
    "POST /7770001/register": () => ({ success: true }),
  });
  const res = response();
  await ctrl.whatsappEmbeddedSignup(req({ code: "abc", waba_id: "5550001", phone_number_id: "7770001" }), res);
  assert.equal(res.code, 200);
  assert.deepEqual({ ...res.data }, { connected: true, display_phone_number: "+91 90000 00000", verified_name: "Acme" });
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/5550001/subscribed_apps"));
  const register = calls.find((c) => c.path === "/7770001/register");
  assert.match(register.body.pin, /^\d{6}$/);
  const saved = JSON.parse(writes.find((w) => w.sql.startsWith("UPDATE tenants")).params[0]);
  assert.equal(saved.whatsapp_access_token, "biz-token");
  assert.equal(saved.whatsapp_business_account_id, "5550001");
  assert.equal(saved.whatsapp_app_id, "111");
  assert.equal(saved.whatsapp_connected_via, "embedded_signup");
  assert.equal(saved.whatsapp_two_step_pin, register.body.pin);
  assert.equal(saved.whatsapp_auto_responder_enabled, true, "existing settings are kept");
  assert.ok(writes.some((w) => w.sql.includes("integration_health")));
});

test("embedded signup skips registration for numbers already on the Cloud API", async () => {
  const { ctrl, calls } = setup({
    "GET /oauth/access_token": () => ({ access_token: "biz-token" }),
    "GET /5550001/phone_numbers": () => ({ data: [{ id: "7770001", platform_type: "CLOUD_API" }] }),
    "POST /5550001/subscribed_apps": () => ({ success: true }),
  });
  const res = response();
  await ctrl.whatsappEmbeddedSignup(req({ code: "abc", waba_id: "5550001", phone_number_id: "7770001" }), res);
  assert.equal(res.code, 200);
  assert.ok(!calls.some((c) => c.path.endsWith("/register")));
});

test("embedded signup rejects a number outside the WABA and malformed input without saving", async () => {
  const { ctrl, writes } = setup({
    "GET /oauth/access_token": () => ({ access_token: "biz-token" }),
    "GET /5550001/phone_numbers": () => ({ data: [{ id: "8880001" }] }),
  });
  let res = response();
  await ctrl.whatsappEmbeddedSignup(req({ code: "abc", waba_id: "5550001", phone_number_id: "7770001" }), res);
  assert.equal(res.code, 400);
  res = response();
  await ctrl.whatsappEmbeddedSignup(req({ code: "abc", waba_id: "../me", phone_number_id: "7770001" }), res);
  assert.equal(res.code, 400);
  assert.ok(!writes.some((w) => w.sql.startsWith("UPDATE tenants")));
});
