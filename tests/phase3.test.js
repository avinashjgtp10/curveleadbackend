const test = require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
const {buildLeadSearch}=require('../utils/leadSearch');
function load(file,deps={}) {const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{module,console,Date,URL,process:{env:{}},fetch:deps.fetch,require:k=>deps[k]||{}});return module.exports;}
test('lead search is bounded and treats wildcard input literally; fuzzy is names only',()=>{
 assert.equal(buildLeadSearch('   ',2),null);
 assert.throws(()=>buildLeadSearch('x'.repeat(201),2),{status:422});
 const s=buildLeadSearch('100%_Hair',2);assert.equal(s.values[2],'%100\\%\\_Hair%');assert.equal(s.fuzzy,null);
 for(const search of ['LD-04501','235151','+91 89802 35151','abc']) assert.equal(buildLeadSearch(search,2).fuzzy,null);
 assert.ok(buildLeadSearch('Harissh',2).fuzzy);
});
test('sync status is tenant scoped, read-only and returns no settings/credentials',async()=>{
 const controller=load('controllers/integrationController.js',{'../config/db':{query:async(sql,params)=>{assert.match(sql,/^SELECT/);assert.deepEqual(Array.from(params),['tenant-a']);return{rows:[{configured:true,last_synced_at:'2026-09-30T10:00:00.000Z',secret:'must-not-return'}]};}}});
 const res={status(){return this;},json(data){this.data=data;}};await controller.facebookSyncStatus({tenantId:'tenant-a'},res);
 assert.deepEqual(JSON.parse(JSON.stringify(res.data)),{configured:true,last_synced_at:'2026-09-30T10:00:00.000Z'});
});
test('sync records successful completion only; failures preserve the last-good timestamp',async()=>{
 let fail=false,writes=0;
 const sync=load('utils/metaLeadSync.js',{'../config/db':{query:async(sql,params)=>{
  if(sql.startsWith('SELECT name'))return{rows:[{settings:{meta_page_id:'page',meta_page_access_token:'test'}}]};
  assert.match(sql,/^UPDATE tenants/);assert.equal(params[0],'tenant-a');assert.match(params[1],/Z$/);writes++;return{rows:[]};
 }},fetch:async()=>({json:async()=>fail?{error:{message:'Meta unavailable'}}:{data:[]}})});
 const result=await sync.syncFacebookLeadsForTenant('tenant-a');assert.match(result.last_synced_at,/Z$/);assert.equal(writes,1);
 fail=true;await assert.rejects(sync.syncFacebookLeadsForTenant('tenant-a'),/Meta unavailable/);assert.equal(writes,1);
});
test('manual sync returns the same authoritative completion timestamp',async()=>{
 const ctrl=load('controllers/integrationController.js',{'../utils/metaLeadSync':{syncFacebookLeadsForTenant:async id=>{assert.equal(id,'t');return{created:1,skipped:0,last_synced_at:'2026-09-30T10:00:00.000Z'};}}});
 const res={status(){return this;},json(data){this.data=data;}};await ctrl.facebookSyncLeads({tenantId:'t'},res);assert.equal(res.data.last_synced_at,'2026-09-30T10:00:00.000Z');
});
