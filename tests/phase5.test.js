const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {Client}=require('pg');
function load(file,deps){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{module,console,Date,Set,Map,JSON,require:k=>deps[k]||{}});return module.exports;}
const response=()=>({code:200,status(c){this.code=c;return this;},json(d){this.data=d;return this;}});
test('Phase 5 migration, onboarding, quota, follow-up review and funnel execute in PostgreSQL with tenant isolation',{skip:!process.env.PHASE5_TEST_DATABASE_URL},async()=>{
 const c=new Client({connectionString:process.env.PHASE5_TEST_DATABASE_URL});await c.connect();const schema='phase5_'+Date.now();
 const t='11111111-1111-1111-1111-111111111111',t2='22222222-2222-2222-2222-222222222222',u='33333333-3333-3333-3333-333333333333',u2='44444444-4444-4444-4444-444444444444';
 const query=(s,p)=>c.query(s,p),db={query,transaction:async fn=>{await query('BEGIN');try{const value=await fn(c);await query('COMMIT');return value;}catch(e){await query('ROLLBACK');throw e;}}};
 try{
 await query(`CREATE SCHEMA ${schema};SET search_path TO ${schema};SET timezone='UTC';
 CREATE TABLE tenants(id uuid PRIMARY KEY,settings jsonb DEFAULT '{}');
 CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid,name text,is_active boolean DEFAULT true);
 CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,phone text,stage text,source text,assigned_to uuid,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now(),won_at timestamp,deal_value numeric DEFAULT 0,first_response_at timestamp,opted_out_at timestamp);
 CREATE TABLE lead_stages(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,name text,pos int,is_won boolean DEFAULT false,is_lost boolean DEFAULT false,is_active boolean DEFAULT true);
 CREATE TABLE lead_stage_history(tenant_id uuid,lead_id uuid,prev_stage text,new_stage text,changed_at timestamp DEFAULT now());
 CREATE TABLE lead_followups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,lead_id uuid,is_completed boolean DEFAULT false,next_followup_at timestamp,followup_type text,notes text,meeting_url text);
 CREATE TABLE lead_activities(tenant_id uuid,lead_id uuid,activity_type text,title text,description text,created_by uuid);
 CREATE TABLE assignment_rules(tenant_id uuid,is_active boolean DEFAULT true);
 CREATE TABLE automation_sequences(tenant_id uuid,is_active boolean DEFAULT true);
 CREATE TABLE automation_enrollments(tenant_id uuid,lead_id uuid,status text,completed_at timestamp);
 CREATE TABLE outgoing_webhooks(tenant_id uuid,active boolean DEFAULT true);
 CREATE TABLE whatsapp_broadcast_reports(tenant_id uuid);
 CREATE TABLE whatsapp_quota_claims(tenant_id uuid,phone text,claimed_at timestamptz DEFAULT now());
 CREATE TABLE whatsapp_messages(tenant_id uuid,lead_id uuid,direction text,status text,sent_at timestamp DEFAULT now(),is_ai_generated boolean DEFAULT false,is_automated boolean DEFAULT false);
 CREATE TABLE integration_health(tenant_id uuid,provider text,token_valid boolean,checked_at timestamptz);
 CREATE TABLE notifications(tenant_id uuid,user_id uuid,id uuid DEFAULT gen_random_uuid(),reference_type text,reference_id uuid,type text,is_read boolean DEFAULT false,created_at timestamp DEFAULT now());`);
 const migration=fs.readFileSync(path.join(__dirname,'../models/migration_phase5_ui.sql'),'utf8');await query(migration);await query(migration);
 await query('INSERT INTO tenants(id) VALUES($1),($2)',[t,t2]);await query("INSERT INTO users(id,tenant_id,name) VALUES($1,$3,'A'),($2,$3,'B')",[u,u2,t]);
 await query("INSERT INTO lead_stages(tenant_id,name,pos,is_won,is_lost) VALUES($1,'New',1,false,false),($1,'Qualified',2,false,false),($1,'Won',3,true,false),($1,'Lost',4,false,true),($1,'Unqualified',5,false,false)",[t]);
 const leads=(await query("INSERT INTO leads(tenant_id,name,stage,source,assigned_to,phone) VALUES($1,'Own','New','manual',$3,'+919876543210'),($1,'Other rep','Won','import',$4,'+919876123450'),($1,'Lost','Lost','manual',$3,'+919123456789'),($2,'Foreign','New','manual',$3,'+919876123456') RETURNING *",[t,t2,u,u2])).rows;
 const f=(await query("INSERT INTO lead_followups(tenant_id,lead_id,next_followup_at) VALUES($1,$2,now()-interval '8 days'),($1,$3,now()-interval '8 days'),($1,$4,now()-interval '8 days'),($5,$6,now()-interval '8 days'),($1,$2,NULL),($1,$2,now()+interval '1 day') RETURNING *",[t,leads[0].id,leads[1].id,leads[2].id,t2,leads[3].id])).rows;
 const summaries=load('services/followupSummary.js',{'../config/db':db});const controller=load('controllers/followupController.js',{'../config/db':db,'../services/followupSummary':summaries,'../utils/dateTime':require('../utils/dateTime')});
 const req={tenantId:t,user:{role:'staff',id:u},query:{status:'overdue'},body:{},params:{}};
 let res=response();await controller.getSummary(req,res);assert.equal(res.data.overdue,1);assert.equal(res.data.stale,1);assert.equal(res.data.upcoming,1);
 res=response();await controller.getFollowups(req,res);assert.equal(res.data.pagination.total,1);assert.equal(res.data.followups[0].id,f[0].id);
 res=response();await controller.reviewFollowup({...req,params:{id:f[1].id},body:{action:'dismiss'}},res);assert.equal(res.code,404);
 res=response();await controller.reviewFollowup({...req,params:{id:f[0].id},body:{action:'dismiss'}},res);assert.equal(res.code,200);assert.equal((await summaries.summary(t,u)).overdue,0);
 res=response();await controller.updateFollowup({...req,params:{id:f[0].id},body:{next_followup_at:'2099-01-01T00:00:00Z'}},res);assert.equal(res.code,200);assert.equal(res.data.followup.dismissed_at,null);
 res=response();await controller.reviewFollowup({...req,params:{id:f[0].id},body:{action:'lost'}},res);assert.equal(res.code,200);assert.equal((await query('SELECT stage FROM leads WHERE id=$1',[leads[0].id])).rows[0].stage,'Lost');
 const overview=load('services/workspaceOverview.js',{'../config/db':db,'../utils/messagingLimit':{messagingLimit:async()=>1000}});
 let view=await overview.overview(t);assert.equal(view.whatsapp.status,'Not connected');assert.equal(view.whatsapp.limit,null);assert.ok(view.onboarding.completed.includes('import'));assert.equal(view.automations.dedupe,true);
 await assert.rejects(()=>overview.saveOnboarding(t,{step:'invalid'}));await assert.rejects(()=>overview.saveOnboarding(t,{dismissed:true}));
 for(const step of overview.STEPS)await overview.saveOnboarding(t,{step});await overview.saveOnboarding(t,{dismissed:true});assert.equal((await overview.overview(t)).onboarding.dismissed,true);assert.equal((await overview.overview(t2)).onboarding.dismissed,false);
 await query(`UPDATE tenants SET settings=settings||' {"whatsapp_phone_number_id":"id","whatsapp_access_token":"secret"}'::jsonb WHERE id=$1`,[t]);
 await query('INSERT INTO whatsapp_quota_claims(tenant_id,phone) VALUES($1,$2)',[t,leads[0].phone]);await query("INSERT INTO whatsapp_messages(tenant_id,lead_id,direction,status,is_ai_generated) VALUES($1,$2,'outbound','sent',true),($1,$2,'outbound','sent',true)",[t,leads[0].id]);
 view=await overview.overview(t);assert.equal(view.whatsapp.remaining,999);assert.equal(JSON.stringify(view).includes('secret'),false);
 const activity=load('services/dashboardActivity.js',{'../config/db':db});assert.equal((await activity.counts(t,u)).ai_replies,1);assert.equal((await activity.counts(t2,u)).ai_replies,0);
 const metrics=load('services/metrics.js',{'../config/db':db});
 await query("INSERT INTO lead_stage_history(tenant_id,lead_id,prev_stage,new_stage) VALUES($1,$2,'Qualified','Won')",[t,leads[1].id]);
 const reports=load('controllers/reportsController.js',{'../config/db':db,'../services/metrics':metrics});res=response();await reports.getFunnelReport({...req,user:{role:'admin'},query:{period:'this_month'}},res);assert.equal(res.code,200);assert.deepEqual(Array.from(res.data.stages,s=>s.name),['New','Qualified','Won']);assert.equal(res.data.stages[2].reached_count,1);assert.ok(res.data.terminal_stages.some(s=>s.name==='Lost'&&s.count===2));
 // The shared Won predicate counts history even when the lead has been reopened.
 await query("UPDATE leads SET stage='New' WHERE id=$1",[leads[1].id]);const won=await query(`SELECT count(*)::int n FROM leads l WHERE l.tenant_id=$1 AND ${metrics.wonPredicate('$2','$3')}`,[t,new Date(Date.now()-86400000),new Date(Date.now()+86400000)]);assert.equal(won.rows[0].n,1);
 } finally {await query(`DROP SCHEMA ${schema} CASCADE`);await c.end();}
});
test('visible notifications endpoint validates IDs and scopes writes to user and tenant',async()=>{
 const routes={},calls=[];const router={use(){},get(){},put(p,fn){routes[p]=fn;}};
 load('routes/notifications.js',{express:{Router:()=>router},'../config/db':{query:async(s,p)=>{calls.push([s,p]);return{rows:[]};}}});
 const handler=routes['/read-visible'];let res=response();await handler({body:{ids:['bad']},tenantId:'t',user:{id:'u'}},res);assert.equal(res.code,422);assert.equal(calls.length,0);
 res=response();await handler({body:{ids:['11111111-1111-1111-1111-111111111111']},tenantId:'t',user:{id:'u'}},res);assert.equal(res.code,200);assert.deepEqual(Array.from(calls[0][1]).slice(0,2),['t','u']);assert.match(calls[0][0],/tenant_id=\$1 AND user_id=\$2/);
});
