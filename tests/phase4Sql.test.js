const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path");
const { Client, Pool } = require("pg");
const url = process.env.PHASE4_TEST_DATABASE_URL;
function load(file, deps) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
    { module, console, Date, JSON, Set, Map, require: (k) => deps[k] || {} },
  );
  return module.exports;
}
test(
  "Phase 4 migration reruns, concurrent assignments rotate fairly, and event outbox is transactional and tenant scoped",
  { skip: !url },
  async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    const schema = "phase4_" + Date.now();
    let pool;
    const t = "11111111-1111-1111-1111-111111111111",
      t2 = "22222222-2222-2222-2222-222222222222",
      u = "33333333-3333-3333-3333-333333333333",
      u2 = "44444444-4444-4444-4444-444444444444";
    try {
      await c.query(`CREATE SCHEMA ${schema};SET search_path TO ${schema};
 CREATE TABLE tenants(id uuid PRIMARY KEY,settings jsonb DEFAULT '{}');
 CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid,name text,is_active boolean DEFAULT true,team_id uuid,created_at timestamptz DEFAULT now());
 CREATE TABLE assignment_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,priority int DEFAULT 0,is_active boolean DEFAULT true,created_at timestamptz DEFAULT now(),sources text[],campaign_ids uuid[],location_contains text,assign_to_user_id uuid,assign_to_team_id uuid,last_assigned_user_id uuid,sequence_id uuid);
 CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,phone text,email text,source text,stage text,meta_lead_id text,city text,assigned_to uuid,lead_score text DEFAULT 'cold');
 CREATE TABLE lead_stages(tenant_id uuid,name text,is_won boolean,meta_event_name text);
 CREATE TABLE whatsapp_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,lead_id uuid,direction text,status text,sent_at timestamptz DEFAULT now());
 CREATE TABLE lead_activities(tenant_id uuid,lead_id uuid,activity_type text,title text,metadata jsonb);
 CREATE TABLE notifications(tenant_id uuid,user_id uuid,title text,message text,type text,reference_type text,reference_id uuid);`);
      const migration = fs.readFileSync(
        path.join(__dirname, "../models/migration_phase4_features.sql"),
        "utf8",
      );
      await c.query(migration);
      await c.query(migration);
      await c.query("INSERT INTO tenants(id) VALUES($1),($2)", [t, t2]);
      await c.query(
        "INSERT INTO users(id,tenant_id,name) VALUES($1,$3,'A'),($2,$3,'B')",
        [u, u2, t],
      );
      await c.query(
        "INSERT INTO lead_stages(tenant_id,name,is_won) VALUES($1,'won',true)",
        [t],
      );
      await c.query(
        "INSERT INTO assignment_rules(tenant_id,name,sources,location_contains,staff_ids) VALUES($1,'Mumbai',ARRAY['meta_ads'],'mumbai',$2)",
        [t, [u, u2]],
      );
      await c.query(
        "INSERT INTO outgoing_webhooks(tenant_id,url,secret,events) VALUES($1,'https://example.com','secret',ARRAY['lead.created','lead.stage_changed','lead.won']),($2,'https://example.com','secret',ARRAY['lead.created'])",
        [t, t2],
      );
      const leads = (
        await c.query(
          "INSERT INTO leads(tenant_id,name,source,city,stage) SELECT $1,'Lead '||i,'meta_ads','Mumbai','new' FROM generate_series(1,6) i RETURNING *",
          [t],
        )
      ).rows;
      pool = new Pool({
        connectionString: url,
        options: `-c search_path=${schema}`,
        max: 6,
      });
      const db = {
        transaction: async (fn) => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const result = await fn(client);
            await client.query("COMMIT");
            return result;
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          } finally {
            client.release();
          }
        },
      };
      const assign = load("utils/leadAssignment.js", { "../config/db": db });
      await Promise.all(
        leads.map((lead) => assign.applyAssignmentRules({ tenantId: t, lead })),
      );
      const counts = (
        await c.query(
          "SELECT assigned_to,count(*)::int n FROM leads GROUP BY assigned_to",
        )
      ).rows;
      assert.deepEqual(counts.map((x) => x.n).sort(), [3, 3]);
      assert.equal(
        (await c.query("SELECT count(*)::int n FROM lead_activities")).rows[0]
          .n,
        6,
      );
      assert.equal(
        (await c.query("SELECT count(*)::int n FROM notifications")).rows[0].n,
        6,
      );
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int n FROM webhook_deliveries WHERE tenant_id=$1",
            [t2],
          )
        ).rows[0].n,
        0,
      );
      await c.query("BEGIN");
      await c.query("UPDATE leads SET stage='won' WHERE id=$1", [leads[0].id]);
      await c.query("ROLLBACK");
      assert.equal(
        (await c.query("SELECT count(*)::int n FROM webhook_deliveries"))
          .rows[0].n,
        6,
      );
      await c.query(
        `UPDATE tenants SET settings='{"meta_capi_enabled":true}' WHERE id=$1`,
        [t],
      );
      await c.query("UPDATE leads SET meta_lead_id='meta' WHERE id=$1", [
        leads[0].id,
      ]);
      await c.query("UPDATE leads SET stage='won' WHERE id=$1", [leads[0].id]);
      await c.query("UPDATE leads SET stage='won' WHERE id=$1", [leads[0].id]);
      assert.equal(
        (await c.query("SELECT count(*)::int n FROM webhook_deliveries"))
          .rows[0].n,
        8,
      );
      assert.equal(
        (await c.query("SELECT count(*)::int n FROM meta_capi_queue")).rows[0]
          .n,
        1,
      );
      assert.ok(
        (
          await c.query(
            "SELECT last_lead_received_at FROM integration_health WHERE tenant_id=$1",
            [t],
          )
        ).rows[0].last_lead_received_at,
      );
      const tracking = load("services/features.js", { "../config/db": db });
      await c.query(
        "INSERT INTO content_links VALUES('test',$1,$2,'brochure',$2,'Guide','https://example.com',NULL,now())",
        [t, leads[0].id],
      );
      await Promise.all([
        tracking.viewContent("test"),
        tracking.viewContent("test"),
      ]);
      assert.equal(
        (
          await c.query(
            "SELECT count(*)::int n FROM lead_activities WHERE activity_type='content_view'",
          )
        ).rows[0].n,
        1,
      );
      const report=(await c.query("INSERT INTO whatsapp_broadcast_reports(tenant_id,template_name,recipients,sent,failed) VALUES($1,'hello',3,2,1) RETURNING id",[t])).rows[0];
    await c.query("INSERT INTO whatsapp_messages(tenant_id,lead_id,direction,status,broadcast_id,broadcast_sent,sent_at) VALUES($1,$2,'outbound','read',$4,true,now()-interval '1 minute'),($1,$3,'outbound','failed',$4,true,now()-interval '1 minute'),($1,$2,'inbound','delivered',NULL,false,now())",[t,leads[0].id,leads[1].id,report.id]);
    const routes=[];const router={use(){},get(p,...f){routes.push([p,f]);},put(){},post(){},delete(){}};
    load('routes/features.js',{express:{Router:()=>router},'../utils/permissions':{requirePermission:()=>()=>{}},'../config/db':{query:(sql,p)=>c.query(sql,p)}});
    const response={code:200,status(c){this.code=c;return this;},json(d){this.data=d;}};
    await routes.find(([p])=>p==='/broadcasts')[1][0]({tenantId:t},response);
    assert.equal(response.code,200);assert.equal(response.data.broadcasts[0].failed,2);assert.equal(response.data.broadcasts[0].read,1);assert.equal(response.data.broadcasts[0].delivered,1);assert.equal(response.data.broadcasts[0].replied,1);
  } finally {
      if (pool) await pool.end();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    }
  },
);
