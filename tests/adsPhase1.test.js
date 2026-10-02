const test = require("node:test"), assert = require("node:assert/strict");
const { parseInsightsRow, parseBudgetPaise } = require("../services/metaAds/parseInsights");
const { parseUsageHeaders, usageDelayMs, graphRequest, MetaGraphError, _gates } = require("../utils/metaGraph");

test("insights parser takes one lead action type, never double counting", () => {
  const row = parseInsightsRow({
    date_start: "2026-09-30", spend: "1500.50", impressions: "40000", clicks: "800", ctr: "2", cpc: "1.875625",
    actions: [
      { action_type: "link_click", value: "800" },
      { action_type: "onsite_conversion.lead_grouped", value: "30" },
      { action_type: "lead", value: "30" },
    ],
    cost_per_action_type: [
      { action_type: "onsite_conversion.lead_grouped", value: "50.016667" },
      { action_type: "lead", value: "50.016667" },
    ],
  });
  assert.equal(row.date, "2026-09-30");
  assert.equal(row.spend, 1500.5);
  assert.equal(row.impressions, 40000);
  assert.equal(row.clicks, 800);
  assert.equal(row.leads, 30);
  assert.equal(row.cpl, 50.02);
  assert.equal(row.ctr, 2);
  assert.equal(row.cpc, 1.8756);
});

test("insights parser falls back to grouped lead actions and computes CPL when Meta omits it", () => {
  const row = parseInsightsRow({ spend: "900", impressions: "1000", clicks: "0", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "4" }] });
  assert.equal(row.leads, 4);
  assert.equal(row.cpl, 225);
  assert.equal(row.ctr, 0);
  assert.equal(row.cpc, null, "no clicks → no CPC rather than divide by zero");
});

test("insights parser handles rows with no actions, empty strings and junk", () => {
  const row = parseInsightsRow({ spend: "", impressions: "abc", clicks: undefined });
  assert.deepEqual(
    { spend: row.spend, impressions: row.impressions, clicks: row.clicks, leads: row.leads, cpl: row.cpl, ctr: row.ctr, cpc: row.cpc, actions: row.actions },
    { spend: 0, impressions: 0, clicks: 0, leads: 0, cpl: null, ctr: null, cpc: null, actions: null },
  );
});

test("budget parser keeps paise as integers and treats blanks as unset", () => {
  assert.equal(parseBudgetPaise("50000"), 50000);
  assert.equal(parseBudgetPaise(""), null);
  assert.equal(parseBudgetPaise(undefined), null);
  assert.equal(parseBudgetPaise("x"), null);
});

test("usage headers drive a pre-emptive slowdown and honour regain time", () => {
  const low = parseUsageHeaders({ "x-app-usage": '{"call_count":10,"total_cputime":5,"total_time":3}' });
  assert.equal(low.maxPct, 10);
  assert.equal(usageDelayMs(low), 0);
  const busy = parseUsageHeaders({ "x-business-use-case-usage": JSON.stringify({ 123: [{ type: "ads_insights", call_count: 80, total_cputime: 20, total_time: 30, estimated_time_to_regain_access: 0 }] }) });
  assert.equal(busy.maxPct, 80);
  assert.equal(usageDelayMs(busy), 10000);
  const blocked = parseUsageHeaders({ "x-business-use-case-usage": JSON.stringify({ 123: [{ call_count: 100, estimated_time_to_regain_access: 5 }] }) });
  assert.equal(usageDelayMs(blocked), 300000);
  const account = parseUsageHeaders({ "x-ad-account-usage": '{"acc_id_util_pct":100,"reset_time_duration":90}' });
  assert.equal(usageDelayMs(account), 90000);
  assert.deepEqual(parseUsageHeaders({ "x-app-usage": "not json" }), { maxPct: 0, regainSeconds: 0 });
});

test("graph client retries throttling with backoff, then stops on non-retryable errors", async () => {
  _gates.clear();
  const sleeps = [];
  let calls = 0;
  const http = {
    request: async () => {
      calls++;
      if (calls < 3) throw { response: { status: 400, headers: {}, data: { error: { code: 17, message: "User request limit reached" } } } };
      return { headers: {}, data: { ok: true } };
    },
  };
  const data = await graphRequest({ path: "/act_1/insights", token: "t", gateKey: "act_1", _http: http, _sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] >= sleeps[0] - 1000, "backoff grows");

  const bad = { request: async () => { throw { response: { status: 400, headers: {}, data: { error: { code: 100, message: "Invalid parameter" } } } }; } };
  await assert.rejects(() => graphRequest({ path: "/x", token: "t", _http: bad, _sleep: async () => {} }), (e) => e instanceof MetaGraphError && e.code === 100 && !e.isTransient);

  const expired = { request: async () => { throw { response: { status: 400, headers: {}, data: { error: { code: 190, message: "expired" } } } }; } };
  await assert.rejects(() => graphRequest({ path: "/x", token: "t", _http: expired, _sleep: async () => {} }), (e) => e.isAuth);
});

test("graph client sends the token as a header, never in the URL", async () => {
  _gates.clear();
  let seen;
  const http = { request: async (cfg) => { seen = cfg; return { headers: {}, data: {} }; } };
  await graphRequest({ path: "/me", token: "secret-token", params: { fields: "id" }, _http: http, _sleep: async () => {} });
  assert.equal(seen.headers.Authorization, "Bearer secret-token");
  assert.ok(!seen.url.includes("secret-token"));
  assert.ok(!JSON.stringify(seen.params).includes("secret-token"));
});

// ── PostgreSQL: hierarchy + insights roll-up + dashboard, with tenant isolation ──
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
function load(file, deps) {
  const module = { exports: {} };
  const dir = path.dirname(path.join(__dirname, "..", file));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    module, console, Date, Set, Map, JSON, Math, Number, String, Promise, setTimeout, setInterval, setImmediate, process,
    require: (k) => deps[k] || (k.startsWith(".") ? require(path.join(dir, k)) : require(k)),
  });
  return module.exports;
}
const response = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

test("ads hierarchy, daily roll-ups and CPL dashboard work in PostgreSQL and stay tenant-scoped", { skip: !process.env.ADS_TEST_DATABASE_URL }, async () => {
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.env.ADS_TEST_DATABASE_URL });
  await c.connect();
  const schema = "ads_" + Date.now();
  const query = (s, p) => c.query(s, p);
  const db = { query, transaction: async (fn) => { await query("BEGIN"); try { const v = await fn(c); await query("COMMIT"); return v; } catch (e) { await query("ROLLBACK"); throw e; } } };
  const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
  try {
    await query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; SET timezone='UTC';
      CREATE TABLE tenants(id uuid PRIMARY KEY, name text, settings jsonb DEFAULT '{}');
      CREATE TABLE users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, role text, is_active boolean DEFAULT true);
      CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, source text, status text,
        meta_campaign_id text, meta_adset_id text, daily_budget numeric, lifetime_budget numeric, updated_at timestamp);
      CREATE TABLE lead_stages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, pos int, position int,
        is_won boolean DEFAULT false, is_lost boolean DEFAULT false);
      CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, stage text, campaign_id uuid, assigned_to uuid, created_at timestamp DEFAULT now());
      CREATE TABLE lead_stage_history(tenant_id uuid, lead_id uuid, new_stage text, changed_at timestamp DEFAULT now());`);
    await query(fs.readFileSync(path.join(__dirname, "../models/migration_ads_phase1.sql"), "utf8"));
    await query(`SET search_path TO ${schema}`);
    await query("INSERT INTO tenants(id,name) VALUES($1,'A'),($2,'B')", [A, B]);
    await query(`INSERT INTO lead_stages(tenant_id,name,pos,is_won,is_lost) VALUES
      ($1,'New',1,false,false),($1,'Qualified',2,false,false),($1,'Converted',3,true,false),($1,'Lost',4,false,true)`, [A]);
    await query(fs.readFileSync(path.join(__dirname, "../models/migration_ads_phase1.sql"), "utf8")); // rerun: idempotent, flags qualified stages
    await query(`SET search_path TO ${schema}`);
    const acct = (await query("INSERT INTO ad_accounts(tenant_id,external_id,name,is_primary) VALUES($1,'act_1','Main',true) RETURNING id", [A])).rows[0].id;
    await query("INSERT INTO ad_accounts(tenant_id,external_id,name,is_primary) VALUES($1,'act_9','Other tenant',true)", [B]);

    const findOrCreateMetaCampaign = async ({ tenantId, campaignId, campaignName }) =>
      (await query(`INSERT INTO campaigns(tenant_id,name,source,meta_campaign_id) VALUES($1,$2,'meta_ads',$3) RETURNING id`, [tenantId, campaignName, campaignId])).rows[0].id;
    const hierarchy = load("services/metaAds/hierarchy.js", { "../../config/db": db, "../../utils/metaGraph": {}, "../../utils/metaCampaignMatch": { findOrCreateMetaCampaign } });
    await hierarchy.saveHierarchy({ tenantId: A, adAccountId: acct, campaigns: [{
      id: "120001", name: "Diwali", objective: "OUTCOME_LEADS", effective_status: "ACTIVE", daily_budget: "50000",
      adsets: [{ id: "230001", name: "Pune 25-45", daily_budget: "", ads: [
        { id: "340001", name: "Ad 1", creative: { id: "cr1", thumbnail_url: "https://x/t.jpg", body: "Body", title: "Title" } },
        { id: "340002", name: "Ad 2", creative: {} }] }],
    }] });
    const camp = (await query("SELECT * FROM ad_campaigns WHERE tenant_id=$1", [A])).rows[0];
    assert.equal(camp.daily_budget_paise, "50000");
    assert.ok(camp.campaign_id, "linked to CRM campaign");
    assert.equal((await query("SELECT creative->>'title' t FROM ad_ads WHERE external_id='340001'")).rows[0].t, "Title");

    const insights = load("services/metaAds/insights.js", { "../../config/db": db, "../../utils/metaGraph": {} });
    const row = (ad, date, spend, leads) => ({ ad_id: ad, adset_id: "230001", campaign_id: "120001", date_start: date, spend: String(spend), impressions: "1000", clicks: "20",
      actions: leads ? [{ action_type: "lead", value: String(leads) }] : [] });
    await insights.saveDailyInsights({ tenantId: A, adAccountId: acct, externalAccountId: "act_1", since: "2026-09-01", until: "2026-09-02",
      rows: [row("340001", "2026-09-01", 300, 3), row("340002", "2026-09-01", 100, 1), row("340001", "2026-09-02", 200, 0)] });
    // Re-sync the same range with corrected numbers: replaces, never doubles.
    await insights.saveDailyInsights({ tenantId: A, adAccountId: acct, externalAccountId: "act_1", since: "2026-09-01", until: "2026-09-02",
      rows: [row("340001", "2026-09-01", 300, 3), row("340002", "2026-09-01", 100, 1), row("340001", "2026-09-02", 250, 1)] });
    const levels = (await query(`SELECT entity_type, entity_id, sum(spend)::float spend, sum(leads)::int leads FROM ad_insights_daily
      WHERE tenant_id=$1 GROUP BY 1,2 ORDER BY 1,2`, [A])).rows;
    assert.deepEqual(levels.map((r) => [r.entity_type, r.entity_id, r.spend, r.leads]), [
      ["account", "act_1", 650, 5], ["ad", "340001", 550, 4], ["ad", "340002", 100, 1], ["adset", "230001", 650, 5], ["campaign", "120001", 650, 5]]);
    const day1 = (await query("SELECT ctr::float, cpc::float, cpl::float FROM ad_insights_daily WHERE entity_type='campaign' AND date='2026-09-01'")).rows[0];
    assert.deepEqual(day1, { ctr: 2, cpc: 10, cpl: 100 });

    // CRM leads on the linked campaign: 4 leads, 2 qualified (one via history), 1 converted.
    const lead = async (stage, history) => {
      const id = (await query("INSERT INTO leads(tenant_id,stage,campaign_id,created_at) VALUES($1,$2,$3,'2026-09-01 10:00') RETURNING id", [A, stage, camp.campaign_id])).rows[0].id;
      if (history) await query("INSERT INTO lead_stage_history(tenant_id,lead_id,new_stage) VALUES($1,$2,$3)", [A, id, history]);
    };
    await lead("New"); await lead("Lost", "Qualified"); await lead("Converted"); await lead("New");

    const ctrl = load("controllers/adsController.js", { "../config/db": db, "../jobs/queues": {}, "../services/metaAds/client": {} });
    let res = response();
    await ctrl.dashboard({ tenantId: A, user: { role: "admin" }, query: { from: "2026-09-01", to: "2026-09-02" } }, res);
    assert.equal(res.code, 200);
    const d = res.data.campaigns[0];
    assert.deepEqual([d.spend, d.meta_leads, d.meta_cpl, d.crm_leads, d.qualified_leads, d.cost_per_qualified, d.converted_leads, d.cost_per_converted],
      [650, 5, 130, 4, 2, 325, 1, 650]);
    assert.equal(res.data.totals.cost_per_converted, 650);

    res = response();
    await ctrl.listCampaigns({ tenantId: A, query: { from: "2026-09-01", to: "2026-09-30" } }, res);
    assert.equal(res.data.campaigns.length, 1);
    assert.equal(res.data.campaigns[0].cpl, 130);

    // Tenant B: its own (empty) account; can't read A's campaign drill-down.
    res = response();
    await ctrl.listCampaigns({ tenantId: B, query: {} }, res);
    assert.deepEqual(res.data.campaigns, []);
    res = response();
    await ctrl.listAdsets({ tenantId: B, params: { id: camp.id }, query: {} }, res);
    assert.equal(res.code, 404);
    res = response();
    await ctrl.dailyInsights({ tenantId: B, query: { entity_type: "campaign", entity_id: "120001", from: "2026-09-01", to: "2026-09-02" } }, res);
    assert.deepEqual(res.data.days, []);
    res = response();
    await ctrl.listCampaigns({ tenantId: B, query: { account_id: acct } }, res);
    assert.equal(res.code, 404, "another tenant's account id is not found");
  } finally {
    await query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await c.end();
  }
});

test("ads date range validation", () => {
  const { dateRange } = require("../controllers/adsController");
  assert.deepEqual(dateRange({ from: "2026-09-01", to: "2026-09-30" }), { from: "2026-09-01", to: "2026-09-30" });
  assert.throws(() => dateRange({ from: "2026-09-30", to: "2026-09-01" }), /from ≤ to/);
  assert.throws(() => dateRange({ from: "2025-01-01", to: "2026-09-01" }), /400 days/);
  assert.throws(() => dateRange({ from: "x", to: "2026-09-01" }), /YYYY-MM-DD/);
});

test("async insights report: polls until complete, then pages results; fails clearly on a failed job", async () => {
  const calls = [];
  const statuses = ["Job Running", "Job Running", "Job Completed"];
  const graph = {
    graphRequest: async (o) => {
      calls.push(o.method || "GET");
      if (o.method === "POST") { assert.equal(o.data.level, "ad"); assert.equal(o.data.time_increment, 1); assert.deepEqual({ ...o.data.time_range }, { since: "2026-09-01", until: "2026-09-03" }); return { report_run_id: "777" }; }
      return { async_status: statuses.shift() };
    },
    graphPaged: async (o) => { assert.equal(o.path, "/777/insights"); return [{ ad_id: "1" }]; },
  };
  const insights = load("services/metaAds/insights.js", { "../../config/db": {}, "../../utils/metaGraph": graph });
  const rows = await insights.fetchDailyAdInsights("act_1", "t", { since: "2026-09-01", until: "2026-09-03" }, { _sleep: async () => {} });
  assert.equal(rows.length, 1);
  assert.deepEqual(calls, ["POST", "GET", "GET", "GET"]);
  const failing = load("services/metaAds/insights.js", { "../../config/db": {}, "../../utils/metaGraph": {
    graphRequest: async (o) => (o.method === "POST" ? { report_run_id: "8" } : { async_status: "Job Failed" }), graphPaged: async () => [] } });
  await assert.rejects(() => failing.fetchDailyAdInsights("act_1", "t", { since: "2026-09-01", until: "2026-09-01" }, { _sleep: async () => {} }), /job failed/);
});

test("sync range: 90-day backfill first, then re-pulls the last 3 days", () => {
  const { syncRange } = load("services/metaAds/sync.js", { "../../config/db": {}, "./client": {}, "./hierarchy": {}, "./insights": {}, "../../utils/metaGraph": {} });
  const now = new Date("2026-10-02T12:00:00Z");
  assert.deepEqual({ ...syncRange({}, now) }, { since: "2026-07-04", until: "2026-10-02" });
  assert.deepEqual({ ...syncRange({ insights_synced_through: "2026-10-02" }, now) }, { since: "2026-09-30", until: "2026-10-02" });
  assert.deepEqual({ ...syncRange({ insights_synced_through: "2026-09-20" }, now) }, { since: "2026-09-18", until: "2026-10-02" });
});

test("in-process job runner retries failures with backoff and de-duplicates by jobId", async () => {
  delete process.env.REDIS_URL;
  const queues = load("jobs/queues/index.js", {});
  let runs = 0;
  queues.register("t:flaky", async () => { runs++; if (runs < 2) throw new Error("boom"); }, { attempts: 3, backoffMs: 5 });
  await queues.enqueue("t:flaky", {}, { jobId: "x" });
  await queues.enqueue("t:flaky", {}, { jobId: "x" }); // duplicate while pending → ignored
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 2);
  await assert.rejects(() => queues.enqueue("t:missing"), /No job handler/);
});

test("legacy ad account ids are normalised to act_ form", () => {
  const { normaliseAccountId } = require("../scripts/migrateAdTokens");
  assert.equal(normaliseAccountId("123"), "act_123");
  assert.equal(normaliseAccountId("act_123"), "act_123");
  assert.equal(normaliseAccountId(""), null);
});
