const { transaction } = require('../config/db');
const { LEAD_STATE_SQL, enrollmentState, finishStep } = require('../jobs/automationSequenceRunner');
const { stopReason } = require('../utils/automationPolicy');
function createRecovery(db={transaction}) {
 return async ({tenantId,enrollmentId,action,providerId,note,userId,answer}) => {
 if(action==='route'){
  const row=await db.transaction(async client => (await client.query(`SELECT lead_id FROM automation_enrollments WHERE id=$1 AND tenant_id=$2 AND status='human_review'`,[enrollmentId,tenantId])).rows[0]);
  if(!row)throw Object.assign(new Error('No reply awaiting human review was found.'),{status:409});
  const result=await require('./automationReplies').createReplyRouter(db)({tenantId,leadId:row.lead_id,messageId:`review:${require('crypto').randomUUID()}`,text:answer,reviewedEnrollmentId:enrollmentId});
  if(!result.classification)throw Object.assign(new Error('Could not route this answer. Resume any manual pause first and check the branch configuration.'),{status:409});
  return{message:'Reviewed reply routed.'};
 }
 return db.transaction(async client => {
  const row=(await client.query('SELECT * FROM automation_enrollments WHERE id=$1 AND tenant_id=$2',[enrollmentId,tenantId])).rows[0];
  if(!row)throw Object.assign(new Error('Enrolment not found.'),{status:404});
  const lead=(await client.query(LEAD_STATE_SQL,[row.lead_id,tenantId])).rows[0];
  const e=await enrollmentState(client,{id:enrollmentId,tenant_id:tenantId});
  if(stopReason(lead,e.stop_conditions))throw Object.assign(new Error('A stop condition applies; this enrolment cannot resume.'),{status:409});
  if(e.claim_until && new Date(e.claim_until)>new Date())throw Object.assign(new Error('A worker is still processing this step. Wait for its claim to expire.'),{status:409});
  const uncertain=e.status==='uncertain';
  if(action==='retry' && !['blocked','failed'].includes(e.status))throw Object.assign(new Error('Only failed or blocked steps can be retried directly.'),{status:409});
  if(action!=='retry' && (!uncertain || !['confirmed_sent','confirmed_not_sent'].includes(action) || !note?.trim()))throw Object.assign(new Error('Uncertain delivery needs a reconciliation note and an explicit provider outcome.'),{status:422});
  if(action==='confirmed_sent'){
   if(!providerId?.trim())throw Object.assign(new Error('Provide the confirmed provider message ID.'),{status:422});
   const steps=(await client.query('SELECT * FROM automation_sequence_steps WHERE sequence_id=$1 AND tenant_id=$2 ORDER BY step_order',[e.sequence_id,tenantId])).rows;
   if(!steps[e.current_step])throw Object.assign(new Error('Restore the missing step before reconciling.'),{status:409});
   await finishStep(client,e,steps[e.current_step],steps,providerId.trim());
  }else{
   await client.query(`UPDATE automation_send_attempts SET status='ready',attempts=0,error=NULL,updated_at=now() WHERE enrollment_id=$1 AND step_order=$2`,[e.id,e.current_step]);
   await client.query(`UPDATE automation_enrollments SET status='active',next_send_at=now(),last_error=NULL,blocked_reason=NULL,claim_token=NULL,claim_until=NULL WHERE id=$1`,[e.id]);
  }
  await client.query(`INSERT INTO lead_activities(tenant_id,lead_id,activity_type,title,description,created_by) VALUES($1,$2,'automation_recovery','Automation step recovery',$3,$4)`,[tenantId,e.lead_id,`${action}: ${note || 'Operator requested retry after fixing the cause.'}`,userId]);
  return {message:lead.ai_paused?'Step recovered; manual pause remains in effect.':'Step recovered.'};
 });
 };
}
const recoverEnrollment=createRecovery();
module.exports={recoverEnrollment,createRecovery};
