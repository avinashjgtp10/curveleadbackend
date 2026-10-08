const { transaction } = require('../config/db');
const { matchRoute, stopReason } = require('../utils/automationPolicy');
const { LEAD_STATE_SQL } = require('../jobs/automationSequenceRunner');
function createReplyRouter(db = { transaction }) {
 return async ({ tenantId, leadId, messageId, text, messageAt, reviewedEnrollmentId }) => db.transaction(async client => {
  const lead=(await client.query(LEAD_STATE_SQL,[leadId,tenantId])).rows[0];
  if(!lead)return {handled:false};
  const claimed=await client.query(`INSERT INTO automation_reply_events(tenant_id,message_id,lead_id,outcome) VALUES($1,$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING message_id`,[tenantId,messageId,leadId]);
  if(!claimed.rows.length)return {handled:true,duplicate:true};
  const record=(outcome,classification=null,enrollmentId=null)=>client.query(`UPDATE automation_reply_events SET outcome=$3,classification=$4,enrollment_id=$5 WHERE tenant_id=$1 AND message_id=$2`,[tenantId,messageId,outcome,classification,enrollmentId]);
  if(lead.opted_out || lead.ai_paused){await record(lead.opted_out?'opted_out':'human_takeover');return{handled:true};}
  const pending=(await client.query(`SELECT e.*,s.stop_conditions FROM automation_enrollments e JOIN automation_sequences s ON s.id=e.sequence_id AND s.tenant_id=e.tenant_id
   WHERE e.tenant_id=$1 AND e.lead_id=$2 AND e.awaiting_step IS NOT NULL AND s.is_active=true
    AND ($3::uuid IS NULL OR (e.id=$3 AND e.status='human_review'))
    AND e.status IN ('active','blocked','failed','human_review','awaiting_reply') ORDER BY e.enrolled_at FOR UPDATE OF e`,[tenantId,leadId,reviewedEnrollmentId || null])).rows;
  // Legacy sequences retain automatic stop-on-reply, independently of routing.
  await client.query(`UPDATE automation_enrollments e SET status='cancelled',cancelled_at=now(),cancelled_reason='replied',claim_token=NULL,claim_until=NULL
   FROM automation_sequences s WHERE s.id=e.sequence_id AND s.tenant_id=e.tenant_id AND e.tenant_id=$1 AND e.lead_id=$2
   AND e.status IN ('active','blocked','failed','awaiting_reply') AND COALESCE((s.stop_conditions->>'on_reply')::boolean,true)
   AND NOT EXISTS(SELECT 1 FROM automation_sequence_steps st WHERE st.sequence_id=s.id AND st.tenant_id=s.tenant_id AND jsonb_array_length(st.reply_routes)>0)`,[tenantId,leadId]);
  if(!pending.length){await record('no_question');return {handled:false};}
  const review=async(reason)=>{
   await client.query(`UPDATE automation_enrollments SET status='human_review',last_error=$3,claim_token=NULL,claim_until=NULL WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,[tenantId,pending.map(e=>e.id),reason]);
   await client.query(`UPDATE leads SET ai_paused=true WHERE id=$1 AND tenant_id=$2`,[leadId,tenantId]);
   await client.query(`INSERT INTO lead_activities(tenant_id,lead_id,activity_type,title,description) VALUES($1,$2,'automation_reply_review','Reply needs human review',$3)`,[tenantId,leadId,reason]);
   await record('human_review');return {handled:true,review:true};
  };
  if(pending.length!==1)return review('More than one sequence is awaiting an answer. Choose the classification manually.');
  const e=pending[0];
  if(messageAt && new Date(messageAt).getTime()<Math.floor(new Date(e.awaiting_since).getTime()/1000)*1000){await record('before_question',null,e.id);return{handled:true};}
  const stop=stopReason(lead,e.stop_conditions);
  if(stop){await client.query(`UPDATE automation_enrollments SET status='cancelled',cancelled_at=now(),cancelled_reason=$2,claim_token=NULL,claim_until=NULL,awaiting_step=NULL WHERE id=$1`,[e.id,stop]);await record(stop,null,e.id);return{handled:true};}
  // Ignore delayed retries of an earlier message, not answers to this question.
  // Webhook code passes provider time so a message received before the question
  // cannot be routed merely because webhook delivery was delayed.
  const matched=matchRoute(e.awaiting_routes || [],text);
  if(!matched.route)return review(matched.reason);
  const route=matched.route;
  const target=(await client.query(`SELECT id FROM automation_sequences WHERE id=$1 AND tenant_id=$2 AND is_active=true`,[route.sequence_id,tenantId])).rows[0];
  const first=target && (await client.query(`SELECT delay_minutes FROM automation_sequence_steps WHERE sequence_id=$1 AND tenant_id=$2 ORDER BY step_order LIMIT 1`,[route.sequence_id,tenantId])).rows[0];
  if(!first || route.sequence_id===e.sequence_id)return review('Reply target sequence is inactive, missing, empty, or points back to this sequence.');
  const branch=await client.query(`INSERT INTO automation_enrollments(tenant_id,lead_id,sequence_id,current_step,status,next_send_at)
    VALUES($1,$2,$3,0,'active',now()+($4||' minutes')::interval) ON CONFLICT(tenant_id,lead_id,sequence_id) DO NOTHING RETURNING id`,[tenantId,leadId,route.sequence_id,first.delay_minutes]);
  if(!branch.rows.length)return review('Lead was already enrolled in this branch. No duplicate branch was started.');
  await client.query(`UPDATE leads SET tags=ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}')||ARRAY[$3]::text[])),automation_unresponsive=false WHERE id=$1 AND tenant_id=$2`,[leadId,tenantId,route.classification]);
  await client.query(`UPDATE automation_enrollments SET status='cancelled',cancelled_at=now(),cancelled_reason='reply_routed',awaiting_step=NULL,claim_token=NULL,claim_until=NULL WHERE id=$1 AND tenant_id=$2`,[e.id,tenantId]);
  await record('routed',route.classification,e.id);
  await client.query(`INSERT INTO lead_activities(tenant_id,lead_id,activity_type,title,description) VALUES($1,$2,'automation_reply_routed','Reply routed',$3)`,[tenantId,leadId,`${route.classification}: branch sequence started.`]);
  return {handled:true,classification:route.classification};
 });
}
const routeSequenceReply=createReplyRouter();
module.exports={routeSequenceReply,createReplyRouter};
