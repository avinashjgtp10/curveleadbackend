const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Client } = require('pg');
const { buildLeadSearch } = require('../utils/leadSearch');
const url = process.env.PHASE3_TEST_DATABASE_URL;
test('ranked SQL search: exact/prefix/contains, Unicode, literal patterns, fallback, filters and pagination', { skip: !url }, async () => {
 const client = new Client({ connectionString: url }); await client.connect();
 const schema = 'phase3_' + Date.now();
 const tenant = '11111111-1111-1111-1111-111111111111', other = '22222222-2222-2222-2222-222222222222';
 const staff = '33333333-3333-3333-3333-333333333333', staffB = '44444444-4444-4444-4444-444444444444';
 const query = (sql, params) => client.query(sql, params);
 try {
  await query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},public;
   CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,assigned_to uuid,campaign_id uuid,name text,phone text,lead_number varchar(20),stage text,source text,lead_score text,lead_status text,intent_score int,created_at timestamp DEFAULT now(),lead_date timestamp,updated_at timestamp DEFAULT now(),first_response_at timestamp,response_time_seconds int);
   CREATE TABLE users(id uuid PRIMARY KEY,name text);
   CREATE TABLE campaigns(id uuid PRIMARY KEY,name text,source text);
   CREATE TABLE lead_stages(id uuid,name text,tenant_id uuid,pos int,is_won boolean,is_lost boolean);
   CREATE TABLE lead_followups(lead_id uuid,next_followup_at timestamp,followup_type text,is_completed boolean);
   CREATE TABLE lead_attachments(lead_id uuid);`);
  const migration = fs.readFileSync(path.join(__dirname,'../models/migration_phase3_search.sql'),'utf8');
  await query(migration); await query(migration);
  const rows = [
   ['Harish','LD-04501','+91 89802 35151','new',tenant,staff],
   ['Harish Kumar','LD-04502','+917676757575','new',tenant,staff],
   ['Salon Harish','LD-04503','+919876543210','new',tenant,staff],
   ['Hair Studio','LD-04504','+919123456789','new',tenant,staff],
   ['Barbar sumit','LD-04505','+919876123450','new',tenant,staff],
   ['Sunita','LD-04506','+919876123451','new',tenant,staff],
   ['𝐒𝐮𝐧𝐢𝐭𝐚 Sharma','LD-04507','+919876123452','new',tenant,staff],
   ['José Pérez','LD-04508','+919876123453','new',tenant,staff],
   ['100% Hair_Studio','LD-04509','+919876123454','new',tenant,staff],
   ['Harish Lost','LD-04510','+919876123455','lost',tenant,staff],
   ['Harish Foreign','LD-04511','+919876123456','new',other,staff],
   ['Harish Other Rep','LD-04512','+919876123457','new',tenant,staffB],
  ];
  for (const [name,id,phone,stage,tid,uid] of rows) await query('INSERT INTO leads(name,lead_number,phone,stage,tenant_id,assigned_to,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[name,id,phone,stage,tid,uid,name==='Harish'?'2025-01-01':'2026-09-01']);
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controllers/leadController.js'),'utf8'), {module,console,require:name=>name==='../config/db'?{query}:name==='../utils/leadSearch'?{buildLeadSearch}:name==='../utils/leadSla'?{computeLeadSla:()=>({})}:{}});
  const run = async (params, role='staff') => {
   const res={code:200,status(c){this.code=c;return this;},json(data){this.data=data;}};
   await module.exports.getLeads({tenantId:tenant,user:{id:staff,role},query:{hide_stages:'lost,unqualified',...params}},res);
   assert.equal(res.code,200,JSON.stringify(res.data));return res.data;
  };
  let result=await run({search:'Harish'});
  assert.deepEqual(result.leads.map(l=>l.name),['Harish','Harish Kumar','Salon Harish']);
  assert.equal(result.pagination.total,3);assert.equal(result.search_mode,'direct');
  assert.equal((await run({search:'Harish',page:2,limit:2})).leads[0].name,'Salon Harish');
  result=await run({search:'Harish',page:9,limit:2});assert.equal(result.leads.length,0);assert.equal(result.search_mode,'direct');assert.equal(result.pagination.total,3);
  assert.equal((await run({search:'Harish'},'admin')).pagination.total,4);
  assert.equal((await run({search:'Harish',hide_stages:''})).pagination.total,4);
  assert.deepEqual((await run({search:'Sunita'})).leads.map(l=>l.name),['Sunita','𝐒𝐮𝐧𝐢𝐭𝐚 Sharma']);
  assert.equal((await run({search:'SUNÍTA'})).pagination.total,2);
  assert.equal((await run({search:'Jose Perez'})).leads[0].name,'José Pérez');
  assert.equal((await run({search:'235151'})).leads[0].name,'Harish');
  assert.equal((await run({search:'+91 (89802) 35151'})).leads[0].name,'Harish');
  assert.equal((await run({search:'ld-04501'})).leads[0].name,'Harish');
  assert.equal((await run({search:'%'})).pagination.total,1);
  assert.equal((await run({search:'_'})).pagination.total,1);
  result=await run({search:'Haris'});assert.equal(result.search_mode,'direct');
  result=await run({search:'Harissh'});assert.equal(result.search_mode,'fuzzy');assert.ok(result.leads.some(l=>l.name==='Harish'));assert.ok(result.leads.every(l=>l.name!=='Hair Studio'));
  result=await run({search:'8888800000'});assert.equal(result.search_mode,'direct');assert.equal(result.pagination.total,0);
  result=await run({search:'Harish',date_from:'2026-01-01',sort:'date',dir:'desc'});assert.equal(result.pagination.total,2);assert.equal(result.leads[0].name,'Harish Kumar');
  const indexCount=await query("SELECT count(*)::int n FROM pg_indexes WHERE schemaname=$1 AND indexname LIKE 'idx_leads_%search_trgm'",[schema]);assert.equal(indexCount.rows[0].n,3);
 } finally {await query(`ROLLBACK; SET search_path TO public; DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.end();}
});
