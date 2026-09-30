const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const quality = require('../utils/dataQuality');
const { mapMetaFields } = require('../utils/metaFieldData');
const { duplicateGroups } = require('../services/duplicates');
const { repairLead, run } = require('../scripts/backfillDataQuality');
const { parseBudgets } = require('../utils/metaBudget');
function load(file, deps = {}) {
 const module = { exports: {} };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'), { module, exports: module.exports, console, Buffer, Date, Set, Map, JSON, process, require: key => deps[key] || {} });
 return module.exports;
}
const response = () => ({ code: 200, status(c) { this.code=c; return this; }, json(data) { this.data=data; return this; } });
test('canonical phone/source validation rejects invalid input, preserves international numbers', () => {
 for (const value of ['8980235151','918980235151','+91 89802 35151']) assert.equal(quality.normalizePhone(value), '+918980235151');
 assert.equal(quality.normalizePhone('+12133734253'), '+12133734253');
 for (const value of ['+99917935110','abc8980235151',null,'123']) assert.throws(() => quality.normalizePhone(value), { status: 422 });
 for (const value of ['Manual','manual',' MANUAL ']) assert.equal(quality.normalizeSource(value), 'manual');
 assert.equal(quality.normalizeSource('Google_ads'), 'google_ads');
});
test('status history has old/new labels, clearing is explicit, unchanged is skipped', () => {
 assert.equal(quality.statusChangeTitle('New', ''), 'Status changed: New → Not set');
 assert.equal(quality.statusChangeTitle('', null), null);
 assert.equal(quality.statusChangeTitle('Interested', 'Interested'), null);
});
test('Meta business, city, staff/chairs and raw custom answers remain available', () => {
 const mapped=mapMetaFields([{name:'Business Name',values:['Salon']},{name:'City',values:['Pune']},{name:'Number of Staff',values:['6']},{name:'Number of Chairs',values:['4']},{name:'Services',values:['Hair','Skin']}]);
 assert.equal(mapped.business_name,'Salon'); assert.equal(mapped.city,'Pune');
 assert.deepEqual(mapped.custom_fields,{number_of_staff:'6',number_of_chairs:'4',services:['Hair','Skin']});
});
test('data repair is idempotent, preserves existing mapped answers, reports invalid phones', async () => {
 const row={id:'x',name:'Hakimâ€™s',source:'Meta Ads',phone:'8980235151',notes:'Meta Lead Form Submission:\nBusiness Name: Salon\nCity: Pune\nNumber of Staff: 6',custom_fields:{number_of_staff:'8'}};
 const repaired=repairLead(row);assert.equal(repaired.patch.name,'Hakim’s');
 assert.equal(repaired.patch.business_name,'Salon');assert.equal(({...row,...repaired.patch}).custom_fields.number_of_staff,'8');
 assert.deepEqual(repairLead({...row,...repaired.patch}).patch,{});
 assert.equal(repairLead({...row,phone:'+99917935110'}).invalidPhone,true);
 assert.equal(quality.repairMojibake('Hakimâs'), 'Hakimâs');
 let calls=0; const db={query:async sql=>{assert.match(sql,/^SELECT/);return {rows:calls++===0?[row]:[]};}};
 await run(db,false);
});
test('UTF-8 CSV input retains non-ASCII text', () => {
 const XLSX=require('xlsx');
 const buffer=Buffer.from('name,phone\nHakim’s Aalim Salon,8980235151\n𝐒𝐮𝐧𝐢𝐭𝐚,7676757575\n','utf8');
 const wb=XLSX.read(buffer.toString('utf8'),{type:'string'});
 const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
 assert.equal(rows[0].name,'Hakim’s Aalim Salon'); assert.equal(rows[1].name,'𝐒𝐮𝐧𝐢𝐭𝐚');
});
test('duplicates match full valid numbers and transitive email, retaining oldest', () => {
 const rows=[{id:'b',phone:'8980235151',email:'a@x.com',created_at:'2026-02-01'}, {id:'a',phone:'+918980235151',created_at:'2026-01-01'}, {id:'c',phone:'7676757575',email:'A@X.COM',created_at:'2026-03-01'}, {id:'d',phone:'+99917935110'},{id:'e',phone:'+99917935110'}];
 assert.equal(duplicateGroups(rows)[0].leads.length,2);
 assert.equal(duplicateGroups(rows,'phone_or_email')[0].leads.length,3);
 assert.equal(duplicateGroups(rows)[0].leads[0].id,'a');
});
test('Meta budgets convert paise and distinguish absent budget from zero', () => {
 assert.deepEqual(parseBudgets({daily_budget:'150000',lifetime_budget:'0'}),{daily_budget:1500,lifetime_budget:0});
 assert.deepEqual(parseBudgets({}),{daily_budget:null,lifetime_budget:null});
});
test('invalid create and import phones return 422 before writes', async () => {
 const controller=load('controllers/leadController.js',{'../utils/dataQuality':quality,'../services/leadIngestion':{ingestLead:async (id, data)=>quality.normalizeLead(data)},'../config/db':{query:async()=>({rows:[]})},xlsx:require('xlsx')});
 const req={tenantId:'t',user:{id:'u',role:'admin'},body:{name:'Test',phone:'+99917935110'}};
 let res=response();await controller.createLead(req,res);assert.equal(res.code,422);
 res=response();await controller.importLeads({...req,file:{originalname:'leads.csv',buffer:Buffer.from('name,phone\nTest,+99917935110')}},res);assert.equal(res.code,422);
});
test('four page endpoints expose identical shared metrics for the same scope', async () => {
 const shared={total_leads:761,won:3,lost:4,unassigned:0,revenue:900,conversion_rate:0.4,active_campaigns:7};
 const scope={workspaceId:'t',from:new Date('2026-09-01Z'),to:new Date('2026-10-01Z')};
 let scopes=0;
 const metrics={metricScope:async req=>{assert.equal(req.query.period,'this_month');scopes++;return scope;},getMetrics:async s=>{assert.equal(s,scope);return shared;},getBreakdown:async()=>[]};
 const query=async sql=>({ rows: /count\(\*\)::int AS total/.test(sql)?[{total:0}] : /FROM campaigns c/.test(sql)?[] : /FROM users u/.test(sql)?[] : /FROM call_recordings/.test(sql)?[] : [new Proxy({}, {get:()=>0})] });
 const deps={'../services/metrics':metrics,'../config/db':{query},'../utils/campaignInsights':{rankCampaigns:x=>x},'../utils/followupHealth':{}};
 const reports=load('controllers/reportsController.js',deps), campaigns=load('controllers/campaignController.js',deps), coaching=load('controllers/playbookController.js',deps);
 const req={tenantId:'t',user:{role:'admin'},query:{period:'this_month'}};
 const results=[];
 for (const endpoint of [reports.getDashboardSummary,reports.getConversionReport,campaigns.getCampaigns,coaching.getCoaching]) {
   const res=response();await endpoint(req,res);assert.equal(res.code,200);results.push(res.data.metrics || res.data);
 }
 for (const result of results) {assert.equal(result.won,3);assert.equal(result.conversion_rate,0.4);assert.equal(result.active_campaigns,7);assert.equal(result.unassigned,0);}
 assert.equal(scopes,4);
});
module.exports={load};

test('ad-set budgets include every page and preserve daily/lifetime dimensions', async () => {
 const {fetchAdSetBudgets} = require('../utils/metaBudget');
 const result = await fetchAdSetBudgets('first', async url => ({json:async()=>url === 'first'
  ? {data:[{daily_budget:'10000'}],paging:{next:'second'}}
  : {data:[{daily_budget:'20000',lifetime_budget:'45000'}]}}));
 assert.deepEqual(result,{daily_budget:300,lifetime_budget:450});
});

test('API-key ingestion rejects invalid phones and returns success for attached duplicates', async () => {
 const deps = {'crypto':require('crypto'),'../config/db':{query:async()=>({rows:[{id:'t'}]})},'../services/leadIngestion':{ingestLead:async(id,data)=>{quality.normalizeLead(data);return {duplicate:true,lead:{id:'old'}};}}};
 const ctrl=load('controllers/integrationController.js',deps);
 const req={headers:{'x-api-key':'test'},query:{},body:{name:'Test',phone:'+99917935110'}};
 let res=response();await ctrl.ingestLead(req,res);assert.equal(res.code,422);
 res=response();await ctrl.ingestLead({...req,body:{name:'Test',phone:'8980235151'}},res);assert.equal(res.code,200);assert.equal(res.data.duplicate,true);assert.equal(res.data.id,'old');
});
