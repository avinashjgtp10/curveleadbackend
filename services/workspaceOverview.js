const {query,transaction}=require('../config/db');
const {messagingLimit}=require('../utils/messagingLimit');
const STEPS=['meta','whatsapp','assignment','import','sequence','team'];
async function snapshot(tenantId,db={query}) {
 const s=(await db.query('SELECT settings FROM tenants WHERE id=$1',[tenantId])).rows[0]?.settings||{};
 const counts=(await db.query(`SELECT
 (SELECT count(*)::int FROM assignment_rules WHERE tenant_id=$1 AND is_active=true) assignment,
 (SELECT count(*)::int FROM automation_sequences WHERE tenant_id=$1 AND is_active=true) sequence,
 (SELECT count(*)::int FROM users WHERE tenant_id=$1 AND is_active=true) team,
 (SELECT count(*)::int FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL AND source='import') imported,
 (SELECT count(*)::int FROM outgoing_webhooks WHERE tenant_id=$1 AND active=true) webhooks,
 (SELECT count(*)::int FROM whatsapp_broadcast_reports WHERE tenant_id=$1) broadcasts`,[tenantId])).rows[0];
 const detected={meta:!!(s.meta_page_id&&s.meta_page_access_token),whatsapp:!!(s.whatsapp_phone_number_id&&s.whatsapp_access_token),assignment:counts.assignment>0,import:counts.imported>0,sequence:counts.sequence>0,team:counts.team>1};
 const completed=STEPS.filter(k=>detected[k]||(s.onboarding_completed||[]).includes(k));
 return {s,counts,detected,completed};
}
const tierCache=new Map();
async function overview(tenantId) {
 const {s,counts,detected,completed}=await snapshot(tenantId);
 let limit=null;
 if(detected.whatsapp) {
  const key=tenantId+':'+s.whatsapp_phone_number_id+':'+s.whatsapp_messaging_limit;
  const cached=tierCache.get(key);
  if(cached&&cached.until>Date.now()) limit=cached.limit;
  else {
   try {limit=await messagingLimit({phone_number_id:s.whatsapp_phone_number_id,access_token:s.whatsapp_access_token},s.whatsapp_messaging_limit);}catch{}
   if(tierCache.size>500) tierCache.clear();
   tierCache.set(key,{limit,until:Date.now()+300000});
  }
 }
 const usage=(await query(`SELECT count(*)::int n FROM (
 SELECT phone FROM whatsapp_quota_claims WHERE tenant_id=$1 AND claimed_at>now()-interval '24 hours'
 UNION SELECT l.phone FROM whatsapp_messages m JOIN leads l ON l.id=m.lead_id AND l.tenant_id=m.tenant_id
 WHERE m.tenant_id=$1 AND m.direction='outbound' AND m.status IN ('sent','delivered','read') AND m.sent_at>now()-interval '24 hours') recipients`,[tenantId])).rows[0].n;
 const health=(await query("SELECT token_valid,checked_at FROM integration_health WHERE tenant_id=$1 AND provider='whatsapp'",[tenantId])).rows[0];
 return {onboarding:{completed,dismissed:!!s.onboarding_dismissed&&completed.length===STEPS.length},
 whatsapp:{status:!detected.whatsapp?'Not connected':(health?.token_valid===false?'Action needed':health?.token_valid===true?'Connected':'Not verified'),limit,remaining:limit===null?null:Math.max(0,limit-usage),used:usage},
 automations:{sources:detected.meta||!!s.google_webhook_secret,assignment:counts.assignment>0,dedupe:s.dedupe_mode!=='off',responder:!!s.whatsapp_auto_responder_enabled,sequences:counts.sequence>0,inbound:(s.inbound_reply_rules||[]).some(r=>r.enabled!==false)||!!s.ai_qualification_enabled,bulk:counts.broadcasts>0,capi:!s.meta_capi_enabled?false:(s.meta_dataset_id&&s.meta_capi_access_token?true:'not_set_up'),webhooks:counts.webhooks>0,reviews:!!s.google_review_request_enabled}};
}
async function saveOnboarding(tenantId,body) {
 if(body.step!==undefined&&!STEPS.includes(body.step)) throw Object.assign(new Error('Invalid onboarding step.'),{status:422});
 if(body.dismissed!==undefined&&typeof body.dismissed!=='boolean') throw Object.assign(new Error('Invalid dismissal.'),{status:422});
 return transaction(async c=>{
  await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenantId]);
  const {completed,s}=await snapshot(tenantId,c);
  if(body.step&&!completed.includes(body.step)) completed.push(body.step);
  if(body.dismissed&&completed.length!==STEPS.length) throw Object.assign(new Error('Complete all six steps before dismissing.'),{status:422});
  const dismissed=body.dismissed===undefined?!!s.onboarding_dismissed:body.dismissed;
  await c.query("UPDATE tenants SET settings=COALESCE(settings,'{}'::jsonb)||$2::jsonb WHERE id=$1",[tenantId,JSON.stringify({onboarding_completed:completed,onboarding_dismissed:dismissed})]);
  return {completed,dismissed};
 });
}
module.exports={STEPS,overview,saveOnboarding,snapshot};
