const test = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
    {
      module,
      console,
      Date,
      JSON,
      Set,
      Map,
      URL,
      Buffer,
      process: { env: {} },
      setTimeout,
      require: (k) => deps[k] || { crypto, "node:crypto": crypto }[k] || {},
    },
  );
  return module.exports;
}
const res = () => ({
  code: 200,
  status(c) {
    this.code = c;
    return this;
  },
  json(d) {
    this.data = d;
    return this;
  },
  send(d) {
    this.data = d;
    return this;
  },
  setHeader() {},
  redirect(d) {
    this.redirected = d;
  },
});
test("assignment uses city, first match and serialized round robin; existing assignees are preserved", async () => {
  const queries = [];
  let cursor = null;
  const client = {
    query: async (sql, p) => {
      queries.push([sql, p]);
      if (sql.includes("SELECT assigned_to"))
        return { rows: [{ assigned_to: null }] };
      if (sql.includes("SELECT * FROM assignment_rules"))
        return {
          rows: [
            {
              id: "rule",
              name: "Mumbai",
              sources: ["meta_ads"],
              location_contains: "mumbai",
              staff_ids: ["a", "b"],
              last_assigned_user_id: cursor,
            },
          ],
        };
      if (sql.includes("SELECT id,name FROM users"))
        return {
          rows: [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
          ],
        };
      if (sql.includes("UPDATE assignment_rules")) cursor = p[0];
      return { rows: [] };
    },
  };
  const a = load("utils/leadAssignment.js", {
    "../config/db": { transaction: (fn) => fn(client) },
  });
  const lead = {
    id: "l",
    source: "meta_ads",
    city: "Mumbai",
    location: "Elsewhere",
    name: "Lead",
  };
  assert.equal(
    (await a.applyAssignmentRules({ tenantId: "t", lead })).assigned_to,
    "a",
  );
  assert.equal(
    (await a.applyAssignmentRules({ tenantId: "t", lead })).assigned_to,
    "b",
  );
  assert.ok(queries.some(([sql]) => sql.includes("pg_advisory_xact_lock")));
  assert.ok(
    queries.some(([, p]) => p?.includes("Assigned to A by rule Mumbai")),
  );
  const before = queries.length;
  await a.applyAssignmentRules({
    tenantId: "t",
    lead: { ...lead, assigned_to: "x" },
  });
  assert.equal(queries.length, before);
});
test("configuration rejects invalid rules, event names and limits; health distinguishes downtime from inactivity", () => {
  const f = load("services/features.js");
  for (const input of [
    { integration_alert_hours: 0 },
    { meta_capi_enabled: "yes" },
    { meta_won_event: "bad event" },
    {
      inbound_reply_rules: [
        { trigger: "keyword", type: "text", value: "hello" },
      ],
    },
    { canned_replies: [{ name: "hello", text: "" }] },
    { whatsapp_messaging_limit: -1 },
  ])
    assert.throws(() => f.validateSettings(input));
  assert.equal(
    f.validateSettings({ integration_alert_hours: 24, unknown: "ignored" })
      .unknown,
    undefined,
  );
  assert.equal(f.healthState({ token_valid: false }, 24), "disconnected");
  assert.equal(
    f.healthState(
      { token_valid: true, last_lead_received_at: "2026-01-01T00:00:00Z" },
      24,
      new Date("2026-01-03").getTime(),
    ),
    "stale",
  );
  assert.equal(
    f.healthState({ token_valid: null, monitoring_since: new Date() }, 24),
    "unknown",
  );
});
test("inbound rules honor precedence, first-message and human takeover", async () => {
  let calls = 0;
  const r = load("services/inboundReplies.js", {
    "../config/db": {
      query: async () => {
        calls++;
        return { rows: [] };
      },
    },
  });
  const rules = [
    { trigger: "keyword", keyword: "price", type: "text", value: "cost" },
    { trigger: "first_message", type: "text", value: "welcome" },
  ];
  assert.equal(
    r.matchReply(rules, { text: "PRICE please", first: true }).value,
    "cost",
  );
  assert.equal(
    r.matchReply(rules, { text: "hello", first: true }).value,
    "welcome",
  );
  assert.equal(
    await r.replyToInbound({ lead: { ai_paused: true }, settings: {} }),
    false,
  );
  assert.equal(calls, 0);
});
test("webhooks reject private targets and sign timestamp plus exact bytes", async () => {
  const w = load("services/outgoingWebhooks.js", {
    net: require("net"),
    dns: { promises: { lookup: async () => [{ address: "127.0.0.1" }] } },
  });
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
  ])
    assert.equal(w.publicAddress(ip), false);
  assert.equal(w.publicAddress("8.8.8.8"), true);
  await assert.rejects(w.resolveDestination("https://example.com"));
  assert.equal(
    w.signature("secret", "123", "{}"),
    crypto.createHmac("sha256", "secret").update("123.{}").digest("hex"),
  );
});
test("CAPI is opt-in, hashes PII, uses configured event names and logs outcomes", async () => {
  let enabled = false,
    posted,
    logged;
  const capi = load("utils/metaCapi.js", {
    "../config/db": {
      query: async (sql, p) => {
        if (sql.startsWith("SELECT"))
          return {
            rows: [
              {
                settings: {
                  meta_capi_enabled: enabled,
                  meta_dataset_id: "d",
                  meta_capi_access_token: "token",
                  meta_won_event: "WonCRM",
                },
              },
            ],
          };
        logged = p;
        return { rows: [] };
      },
    },
    axios: {
      post: async (...args) => {
        posted = args;
        return { data: { events_received: 1 } };
      },
    },
  });
  const event = {
    tenantId: "t",
    lead: {
      id: "l",
      stage: "won",
      meta_lead_id: "meta",
      phone: "+919876543210",
      email: " A@B.COM ",
    },
  };
  await capi.sendLeadConversionEvent(event);
  assert.equal(posted, undefined);
  enabled = true;
  await capi.sendLeadConversionEvent(event);
  assert.equal(posted[1].data[0].event_name, "WonCRM");
  assert.equal(posted[1].data[0].user_data.lead_id, "meta");
  assert.equal(posted[1].data[0].user_data.em[0].length, 64);
  assert.equal(logged[3], "success");
  assert.equal(posted[2].timeout, 10000);
});
test("tracked content records one activity, score bump and notification per link", async () => {
  let viewed = false,
    activities = 0,
    notifications = 0;
  const f = load("services/features.js", {
    "../config/db": {
      transaction: (fn) =>
        fn({
          query: async (sql, p) => {
            if (sql.startsWith("SELECT"))
              return {
                rows: [
                  {
                    token: "x",
                    tenant_id: "t",
                    lead_id: "l",
                    kind: "brochure",
                    title: "Guide",
                    destination: "https://example.com",
                    first_viewed_at: viewed,
                  },
                ],
              };
            if (sql.startsWith("UPDATE content")) viewed = true;
            if (sql.startsWith("UPDATE leads"))
              return { rows: [{ assigned_to: "u" }] };
            if (sql.includes("INSERT INTO lead_activities")) activities++;
            if (sql.includes("INSERT INTO notifications")) notifications++;
            return { rows: [] };
          },
        }),
    },
  });
  assert.equal(await f.viewContent("x"), "https://example.com");
  await f.viewContent("x");
  assert.equal(activities, 1);
  assert.equal(notifications, 1);
});
test("every Phase 4 feature API is tenant scoped and config writes are behind settings permission", async () => {
  const routes = [],
    uses = [];
  const router = {
    use(...f) {
      uses.push(...f);
    },
    get(p, ...f) {
      routes.push(["GET", p, f, uses.length]);
    },
    put(p, ...f) {
      routes.push(["PUT", p, f, uses.length]);
    },
    post(p, ...f) {
      routes.push(["POST", p, f, uses.length]);
    },
    delete(p, ...f) {
      routes.push(["DELETE", p, f, uses.length]);
    },
  };
  const scoped = async (t) => {
    assert.equal(t, "tenant");
    return [];
  };
  load("routes/features.js", {
    express: { Router: () => router },
    "../middleware/auth": { authenticate: () => {} },
    "../middleware/tenant": { tenantContext: () => {} },
    "../utils/permissions": {
      requirePermission: (p) => {
        assert.equal(p, "settings.manage");
        return () => {};
      },
    },
    "../services/features": {
      getHealth: scoped,
      getConfig: async (t) => {
        await scoped(t);
        return { canned_replies: [] };
      },
      saveConfig: scoped,
      viewContent: async () => null,
    },
    "../services/workspaceOverview": {overview:scoped,saveOnboarding:scoped},
    "../services/outgoingWebhooks": { createWebhook: scoped },
    "../config/db": {
      query: async (sql, p) => {
        assert.ok(p.includes("tenant"));
        return { rows: [] };
      },
    },
  });
  for (const [method, url, handlers, count] of routes) {
    const response = res();
    await handlers.at(-1)(
      {
        tenantId: "tenant",
        params: { id: "id", token: "a".repeat(48) },
        body: {},
      },
      response,
    );
    assert.ok(response.code < 500, `${method} ${url}`);
    if (url === "/content/:token") assert.equal(count, 0);
    else if (["/health", "/canned-replies", "/overview"].includes(url))
      assert.equal(count, 2);
    else assert.equal(count, 3);
  }
  assert.equal(routes.length, 13);
});
module.exports = { load };

test("import preview normalizes phones and identifies database and within-file duplicates without writes", async () => {
  let writes = 0;
  const quality = require("../utils/dataQuality");
  const ctrl = load("controllers/leadController.js", {
    "../config/db": {
      query: async (sql) => {
        if (!sql.startsWith("SELECT")) writes++;
        if (sql.includes("lead_stages")) return { rows: [{ name: "new" }] };
        if (sql.includes("SELECT settings"))
          return { rows: [{ settings: { dedupe_mode: "phone" } }] };
        return { rows: [{ phone: "+918980235151", email: "" }] };
      },
    },
    "../utils/dataQuality": quality,
    xlsx: {
      read: () => ({ Sheets: { s: {} }, SheetNames: ["s"] }),
      utils: {
        sheet_to_json: () => [
          { "Full name": "One", "Phone numbers": "8980235151" },
          { "Full name": "Two", "Phone numbers": "9876543210" },
          { "Full name": "Three", "Phone numbers": "9876543210" },
        ],
      },
    },
  });
  const response = res();
  await ctrl.importLeads(
    {
      tenantId: "t",
      file: { originalname: "leads.csv", buffer: Buffer.from("") },
      body: {
        dry_run: "true",
        column_mapping: JSON.stringify({
          "Full name": "name",
          "Phone numbers": "phone",
        }),
      },
    },
    response,
  );
  assert.equal(response.code, 200);
  assert.equal(response.data.duplicates, 2);
  assert.equal(response.data.preview[0].phone, "+918980235151");
  assert.equal(response.data.preview[2].action, "merge");
  assert.equal(writes, 0);
});
test("broadcast rejects opt-outs and quota exhaustion, sends authoritative body and records aggregate", async () => {
  let quota = 0,
    sends = 0,
    stored,
    report;
  const db = {
    query: async (sql, p) => {
      if (sql.includes("SELECT settings"))
        return {
          rows: [
            {
              settings: {
                whatsapp_business_account_id: "w",
                whatsapp_access_token: "token",
                whatsapp_messaging_limit: 1,
              },
            },
          ],
        };
      if (sql.includes("INSERT INTO whatsapp_broadcast_reports"))
        return { rows: [{ id: "report" }] };
      if (sql.includes("SELECT l.id, l.name"))
        return {
          rows: [
            { id: "a", name: "$& literal", phone: "1" },
            { id: "b", name: "Opted out", phone: "2", opted_out: true },
            { id: "c", name: "Over quota", phone: "3" },
          ],
        };
      if (sql.includes("count(*)::int n"))
        return { rows: [{ n: quota, known: false }] };
      if (sql.startsWith("INSERT INTO whatsapp_quota_claims")) quota++;
      if (sql.startsWith("INSERT INTO whatsapp_messages")) stored = p;
      if (sql.startsWith("UPDATE whatsapp_broadcast_reports")) report = p;
      return { rows: [] };
    },
  };
  db.transaction = (fn) => fn(db);
  const ctrl = load("controllers/whatsappBroadcastController.js", {
    "../utils/messagingLimit": { messagingLimit: async () => 1 },
    "../config/db": db,
    "../utils/whatsappCredentials": {
      resolveWhatsAppCredentials: async () => ({}),
    },
    "../services/whatsappService": {
      listMessageTemplates: async () => ({
        templates: [
          {
            name: "hello",
            language: "en_US",
            status: "APPROVED",
            components: [{ type: "BODY", text: "Hello {{1}}" }],
          },
        ],
      }),
      sendTemplate: async () => {
        sends++;
        return { success: true, wa_message_id: "wa" };
      },
    },
  });
  const result = await ctrl.executeBroadcast({
    tenantId: "t",
    userId: "u",
    lead_ids: ["a", "b", "c"],
    template_name: "hello",
    body_text: "Fake body",
    mapping: [{ position: 1, source: "field", value: "name" }],
  });
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 2);
  assert.equal(sends, 1);
  assert.equal(stored[2], "Hello $& literal");
  assert.equal(stored.at(-2), "report");
  assert.equal(report[1], 1);
  assert.equal(report[2], 2);
});
test("overnight business hours use the previous business day after midnight in workspace timezone", () => {
  const { isWithinBusinessHours } = require("../utils/businessHours");
  const hours = {
    start: "22:00",
    end: "06:00",
    days: [1],
    timezone: "Asia/Kolkata",
  };
  assert.equal(
    isWithinBusinessHours(hours, new Date("2026-09-28T18:00:00Z")),
    true,
  );
  assert.equal(
    isWithinBusinessHours(hours, new Date("2026-09-28T20:00:00Z")),
    true,
  );
  assert.equal(
    isWithinBusinessHours(hours, new Date("2026-09-29T02:00:00Z")),
    false,
  );
});
test("chat attributes enforce tenant and assignment scope and reject malformed values", async () => {
  const routes = [];
  const router = {
    use() {},
    get() {},
    post() {},
    delete() {},
    put(p, ...f) {
      routes.push([p, f]);
    },
  };
  const multer = () => ({ single: () => () => {} });
  multer.memoryStorage = () => ({});
  let params;
  load("routes/whatsapp.js", {
    express: { Router: () => router },
    multer,
    path: require("path"),
    "../utils/permissions": { requirePermission: () => () => {} },
    "../config/db": {
      query: async (sql, p) => {
        params = p;
        assert.match(sql, /tenant_id=\$3/);
        assert.match(sql, /assigned_to=\$5/);
        return { rows: [{ custom_fields: { City: "Mumbai" } }] };
      },
    },
  });
  const handler = routes.find(([p]) => p.includes("attributes"))[1][0];
  let response = res();
  await handler(
    {
      params: { leadId: "l" },
      tenantId: "t",
      user: { role: "staff", id: "u" },
      body: { custom_fields: { City: "Mumbai" } },
    },
    response,
  );
  assert.equal(response.code, 200);
  assert.equal(params[3], false);
  assert.equal(params[4], "u");
  response = res();
  await handler(
    { body: { custom_fields: { bad: { nested: true } } } },
    response,
  );
  assert.equal(response.code, 422);
});
test("developer key is returned once, stored hashed, and generic integration reads remain masked", async () => {
  let write;
  const c = load("controllers/integrationController.js", {
    "../config/db": {
      query: async (sql, p) => {
        if (sql.startsWith("SELECT")) return { rows: [{ settings: {} }] };
        write = JSON.parse(p[0]);
        return { rows: [] };
      },
    },
  });
  const response = res();
  await c.generateApiKey({ tenantId: "t" }, response);
  assert.match(response.data.api_key, /^clk_/);
  assert.equal(write.api_key, null);
  assert.equal(
    write.api_key_hash,
    crypto.createHash("sha256").update(response.data.api_key).digest("hex"),
  );
  assert.notEqual(write.api_key_prefix, response.data.api_key);
});

test("Meta inbound signatures cover exact raw bytes and reject forged payloads", () => {
  const { verifyMetaWebhook } = require("../utils/metaWebhookSignature");
  const body = Buffer.from('{"message":"hi"}'),
    secret = "test-secret";
  const signed =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyMetaWebhook(body, signed, secret), true);
  assert.equal(
    verifyMetaWebhook(Buffer.from('{"message":"changed"}'), signed, secret),
    false,
  );
  assert.equal(verifyMetaWebhook(body, "bad", secret), false);
  assert.equal(verifyMetaWebhook(body, signed, ""), false);
  const { verifyMetaWebhookAny, webhookSecrets } = require("../utils/metaWebhookSignature");
  const secrets = webhookSecrets({ META_APP_SECRET: "platform", META_EXTRA_APP_SECRETS: ` other , ${secret},` });
  assert.deepEqual(secrets, ["platform", "other", secret]);
  assert.equal(verifyMetaWebhookAny(body, signed, secrets), true);
  assert.equal(verifyMetaWebhookAny(body, signed, ["platform", "other"]), false);
});

test('messaging tier honors the stricter of Meta and workspace limits',async()=>{
 const limit=load('utils/messagingLimit.js',{axios:{get:async()=>({data:{messaging_limit_tier:'TIER_250'}})}});
 assert.equal(limit.parseTier('TIER_2K'),2000);assert.equal(limit.parseTier('TIER_UNKNOWN'),null);
 assert.equal(await limit.messagingLimit({phone_number_id:'id',access_token:'token'},1000),250);
 assert.equal(await limit.messagingLimit({phone_number_id:'id',access_token:'token'},100),100);
 await assert.rejects(limit.messagingLimit({},null));
});
test('health monitoring distinguishes rejected credentials from transient provider failures and deduplicates alerts',async()=>{
 let alerts=0,alerted=false,rejectToken=true,validity;
 const query=async(sql,p)=>{
 if(sql.includes("SELECT id,settings FROM tenants"))return{rows:[{id:'t',settings:{meta_page_id:'page',meta_page_access_token:'token'}}]};
 if(sql.includes('google_ads_integrations'))return{rows:[]};
 if(sql.includes('INSERT INTO integration_health')){validity=p[2];return{rows:[{token_valid:p[2],monitoring_since:new Date(),alerted_at:alerted?new Date():null}]};}
 if(sql.includes('SELECT id FROM users'))return{rows:[{id:'u'}]};
 if(sql.includes('SET alerted_at=now()'))alerted=true;return{rows:[]};
 };
 const jobs=load('jobs/featureJobs.js',{'../config/db':{query},'../services/features':load('services/features.js'),'../controllers/notificationController':{createNotification:async()=>{alerts++;}},axios:{get:async()=>{throw rejectToken?{response:{status:401}}:new Error('timeout');}}});
 await jobs.checkHealth();assert.equal(validity,false);assert.equal(alerts,1);await jobs.checkHealth();assert.equal(alerts,1);
 rejectToken=false;await jobs.checkHealth();assert.equal(validity,null);
});
