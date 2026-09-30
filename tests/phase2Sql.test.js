const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), path=require('node:path');
const {Client}=require('pg');
const quality=require('../utils/dataQuality');
function load(file,deps){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{module,console,Date,JSON,Set,Map,require:k=>deps[k]||{}});return module.exports;}
const url=process.env.PHASE2_TEST_DATABASE_URL;
test('real SQL: migration reruns, period wins/sources/scoping, ingestion and merge preserve data', {skip:!url}, async()=>{
 const client=new Client({connectionString:url});await client.connect();
 const schema='phase2_'+Date.now();
 const tid='11111111-1111-1111-1111-111111111111', other='22222222-2222-2222-2222-222222222222', staff='33333333-3333-3333-3333-333333333333';
 const query=(s,p)=>client.query(s,p);
 try {
 await query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
 CREATE TABLE tenants(id uuid PRIMARY KEY,settings jsonb DEFAULT '{}');
 CREATE TABLE users(id uuid PRIMARY KEY);
 CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid REFERENCES tenants(id),lead_number int,name text,phone text,email text,source text,stage text DEFAULT 'new',lead_status text,assigned_to uuid,lead_score text,deal_value numeric DEFAULT 0,advance_received numeric DEFAULT 0,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now(),won_at timestamp,notes text,tags text[],business_name text,location text,meta_lead_id text,google_lead_id text);
 CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid REFERENCES tenants(id),status text,created_at timestamp DEFAULT now(),start_date date,end_date date);
 CREATE TABLE lead_stage_history(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,prev_stage text,new_stage text,prev_status text,new_status text,changed_at timestamp DEFAULT now());
 CREATE TABLE lead_activities(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,activity_type text,title text,description text,metadata jsonb,created_by uuid);
 CREATE TABLE lead_notes(id uuid DEFAULT gen_random_uuid(),lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,note text);
 CREATE TABLE whatsapp_messages(id uuid DEFAULT gen_random_uuid(),lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,message text);
 CREATE TABLE automation_enrollments(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,sequence_id uuid,enrolled_at timestamp DEFAULT now(),UNIQUE(tenant_id,lead_id,sequence_id));`);
 const migration=fs.readFileSync(path.join(__dirname,'../models/migration_phase2_data.sql'),'utf8');await query(migration);await query(migration);
 await query('INSERT INTO tenants(id) VALUES($1),($2)',[tid,other]);
 await query(`INSERT INTO campaigns(tenant_id,status,created_at) VALUES ($1,'active','2026-01-01'),($1,'paused','2026-01-01'),($2,'active','2026-01-01')`,[tid,other]);
 const ids=(await query(`INSERT INTO leads(tenant_id,name,phone,source,stage,assigned_to,created_at,won_at) VALUES
 ($1,'Created in period','8980235151','manual','new',$3,'2026-09-02',NULL),
 ($1,'Old win','7676757575','manual','won',$3,'2026-08-01','2026-09-03'),
 ($1,'Not won','9876543210','manual','new',NULL,'2026-09-03',NULL),
 ($2,'Foreign','9876543210','manual','won',$3,'2026-09-03','2026-09-03') RETURNING id`,[tid,other,staff])).rows;
 // Reopening must not remove the win in September; repeated no-op saves must not add a win.
 await query("UPDATE leads SET stage='new' WHERE id=$1",[ids[1].id]);
 await query("UPDATE leads SET stage='new' WHERE id=$1",[ids[1].id]);
 const metrics=load('services/metrics.js',{'../config/db':{query}});
 const scope={workspaceId:tid,from:new Date('2026-09-01T00:00:00Z'),to:new Date('2026-10-01T00:00:00Z'),staffId:null};
 const m=await metrics.getMetrics(scope);assert.equal(m.total_leads,2);assert.equal(m.won,1);assert.equal(m.conversion_rate,50);assert.equal(m.unassigned,1);assert.equal(m.active_campaigns,1);
 const sources=await metrics.getBreakdown(scope,'source');assert.equal(sources[0].won,1);assert.equal(sources[0].total_leads,2);
 const own=await metrics.getMetrics({...scope,staffId:staff});assert.equal(own.total_leads,1);assert.equal(own.won,1);assert.equal(own.unassigned,0);
 const custom=await metrics.metricScope({tenantId:tid,user:{role:'admin'},query:{period:'custom',date_from:'2026-09-01',date_to:'2026-09-30'}});
 assert.equal(custom.from.toISOString(),'2026-08-31T18:30:00.000Z');assert.equal(custom.to.toISOString(),'2026-09-30T18:30:00.000Z');
 const db={query,transaction:async fn=>{await query('BEGIN');try{const v=await fn(client);await query('COMMIT');return v;}catch(e){await query('ROLLBACK');throw e;}}};
 let n=1;
 const ingest=load('services/leadIngestion.js',{'../config/db':db,'../utils/dataQuality':quality,'../utils/leadNumber':{nextLeadNumber:async()=>n++},'../utils/leadAssignment':{assignInTransaction:async(client,tenant,lead)=>lead}}).ingestLead;
 const dup=await ingest(tid,{name:'Again',phone:'+918980235151',source:'Manual',notes:'Second submission'},{submissionKey:'test:1'});
 assert.equal(dup.duplicate,true);assert.equal(dup.lead.id,ids[0].id);
 await ingest(tid,{name:'Again',phone:'918980235151',source:'manual'},{submissionKey:'test:1'});
 assert.equal((await query("SELECT count(*)::int n FROM lead_activities WHERE activity_type='duplicate'")).rows[0].n,1);
 await query(`UPDATE tenants SET settings='{"dedupe_mode":"off"}' WHERE id=$1`,[tid]);
 const extra=await ingest(tid,{name:'Separate',phone:'8980235151',source:'Manual',notes:'Keep note'});assert.equal(extra.duplicate,false);
 await query(`INSERT INTO lead_notes(lead_id,note) VALUES($1,'note');`,[extra.lead.id]);
 await query(`INSERT INTO whatsapp_messages(lead_id,message) VALUES($1,'chat');`,[extra.lead.id]);
 await query(`INSERT INTO automation_enrollments(tenant_id,lead_id,sequence_id) VALUES($1,$2,$4),($1,$3,$4)`,[tid,ids[0].id,extra.lead.id,staff]);
 const controller=load('controllers/leadController.js',{'../config/db':db,'../services/duplicates':require('../services/duplicates'),'../utils/dataQuality':quality});
 const res={code:200,status(c){this.code=c;return this;},json(d){this.data=d;}};
 await controller.mergeDuplicateLeads({tenantId:tid,user:{id:staff},body:{keep_id:ids[0].id,remove_ids:[extra.lead.id]}},res);
 assert.equal(res.code,200,JSON.stringify(res.data));
 assert.equal((await query('SELECT lead_id FROM lead_notes')).rows[0].lead_id,ids[0].id);
 assert.equal((await query('SELECT lead_id FROM whatsapp_messages')).rows[0].lead_id,ids[0].id);
 assert.equal((await query('SELECT count(*)::int n FROM automation_enrollments')).rows[0].n,1);
 assert.match((await query('SELECT notes FROM leads WHERE id=$1',[ids[0].id])).rows[0].notes,/Keep note/);
 assert.equal((await query('SELECT count(*)::int n FROM leads WHERE id=$1',[extra.lead.id])).rows[0].n,0);

 await query(`UPDATE tenants SET settings='{"dedupe_mode":"phone"}' WHERE id=$1`,[tid]);
 const clients=[new Client({connectionString:url}),new Client({connectionString:url})];
 try {
  await Promise.all(clients.map(async c=>{await c.connect();await c.query(`SET search_path TO ${schema}`);}));
  const writers=clients.map(c=>load('services/leadIngestion.js',{'../config/db':{transaction:async fn=>{await c.query('BEGIN');try{const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}}},'../utils/dataQuality':quality,'../utils/leadNumber':{nextLeadNumber:async()=>n++},'../utils/leadAssignment':{assignInTransaction:async(client,tenant,lead)=>lead}}).ingestLead);
  const concurrent=await Promise.all(writers.map(write=>write(tid,{name:'Race',phone:'9876123450',source:'api'})));
  assert.equal(concurrent.filter(r=>r.duplicate).length,1);
  assert.equal(concurrent[0].lead.id,concurrent[1].lead.id);
 } finally {await Promise.all(clients.map(c=>c.end()));}
 } finally {await query(`ROLLBACK; SET search_path TO public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.end();}
});
