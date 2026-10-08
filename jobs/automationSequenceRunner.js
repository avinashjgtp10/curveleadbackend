const { query, transaction } = require('../config/db');
const { randomUUID } = require('crypto');
const { sendTextMessage, sendTemplate, listMessageTemplates } = require('../services/whatsappService');
const { sendEmail } = require('../utils/email');
const { substituteVars } = require('../utils/templateVars');
const { generateFollowUpMessage } = require('../services/groqService');
const { localeFromSettings, zonedParts, wallTimeToUtc } = require('../utils/workspaceLocale');
const { decideConsent, templateCategory } = require('../services/whatsappConsent');
const { stopReason, templatePlan, sendOutcome } = require('../utils/automationPolicy');

// Business hours are the workspace's local time (settings.timezone).
const localHHMM = (settings, now) => {
  const { minutes } = zonedParts(now, localeFromSettings(settings).timezone);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const isWithinBusinessHours = (settings, now) => {
  if (!settings.automation_business_hours_enabled) return true;
  const hhmm = localHHMM(settings, now);
  const start = settings.automation_business_hours_start || '09:00';
  const end = settings.automation_business_hours_end || '20:00';
  return hhmm >= start && hhmm < end;
};

const nextBusinessWindowStart = (settings, now) => {
  const start = settings.automation_business_hours_start || '09:00';
  const end = settings.automation_business_hours_end || '20:00';
  const { timezone } = localeFromSettings(settings);
  const hhmm = localHHMM(settings, now);
  const today = zonedParts(now, timezone).date;
  const next = wallTimeToUtc(`${today}T${start}`, timezone);
  // After today's window has closed, the next start is tomorrow (local calendar).
  if (hhmm >= end) {
    const tomorrow = zonedParts(new Date(next.getTime() + 26 * 60 * 60 * 1000), timezone).date;
    return wallTimeToUtc(`${tomorrow}T${start}`, timezone);
  }
  return next;
};

// Lock order everywhere: lead, then enrolment. Claims are short independent
// transactions; no database connection/retry wrapper repeats a provider call.
const LEAD_STATE_SQL = `SELECT l.*, COALESCE(st.is_won,false) AS is_won, COALESCE(st.is_lost,false) AS is_lost,
 EXISTS(SELECT 1 FROM lead_followups f WHERE f.tenant_id=l.tenant_id AND f.lead_id=l.id AND lower(f.followup_type)='demo' AND NOT f.is_completed AND f.dismissed_at IS NULL) AS has_demo,
 EXISTS(SELECT 1 FROM lead_followups f WHERE f.tenant_id=l.tenant_id AND f.lead_id=l.id AND lower(f.followup_type) IN ('demo','visit')) AS has_booking,
 (SELECT MAX(sent_at) FROM whatsapp_messages w WHERE w.tenant_id=l.tenant_id AND w.lead_id=l.id AND w.direction='inbound') AS last_inbound
 FROM leads l LEFT JOIN LATERAL (SELECT is_won,is_lost FROM lead_stages WHERE tenant_id=l.tenant_id AND lower(name)=lower(l.stage) LIMIT 1) st ON true
 WHERE l.id=$1 AND l.tenant_id=$2 FOR UPDATE OF l`;
const enrollmentState = async (client, row) => (await client.query(
 `SELECT e.*, s.stop_conditions,s.is_active AS sequence_active,t.settings AS tenant_settings,t.name AS tenant_name,t.email AS tenant_email
  FROM automation_enrollments e JOIN automation_sequences s ON s.id=e.sequence_id AND s.tenant_id=e.tenant_id
  JOIN tenants t ON t.id=e.tenant_id WHERE e.id=$1 AND e.tenant_id=$2 FOR UPDATE OF e`, [row.enrollment_id || row.id,row.tenant_id])).rows[0];
const activity = (client, e, title, description) => client.query(
 `INSERT INTO lead_activities(tenant_id,lead_id,activity_type,title,description) VALUES($1,$2,'automation_delivery',$3,$4)`, [e.tenant_id,e.lead_id,title,description]);
async function finishStep(client, e, step, steps, providerId) {
 await client.query(`UPDATE automation_send_attempts SET status='sent',wa_message_id=$3,error=NULL,updated_at=now() WHERE enrollment_id=$1 AND step_order=$2`, [e.id,e.current_step,providerId]);
 const hasQuestion = step.reply_routes?.length > 0;
 const next = steps[e.current_step+1];
 await client.query(`UPDATE automation_enrollments SET current_step=$2,status=$3::text,
  next_send_at=CASE WHEN $4::int IS NULL THEN NULL ELSE now()+($4||' minutes')::interval END,
  completed_at=CASE WHEN $3::text='completed' THEN now() ELSE NULL END,
  awaiting_step=CASE WHEN $5::boolean THEN $6 ELSE awaiting_step END,
  awaiting_since=CASE WHEN $5::boolean THEN now() ELSE awaiting_since END,
  awaiting_routes=CASE WHEN $5::boolean THEN $7::jsonb ELSE awaiting_routes END,
  claim_token=NULL,claim_until=NULL,last_error=NULL,blocked_reason=NULL WHERE id=$1`,
 [e.id,next ? e.current_step+1 : e.current_step,next ? 'active' : (hasQuestion || e.awaiting_step != null ? 'awaiting_reply' : 'completed'),next?.delay_minutes ?? null,hasQuestion,e.current_step,JSON.stringify(step.reply_routes || [])]);
 if (!next && !hasQuestion && e.awaiting_step == null) {
  await client.query(`UPDATE leads SET automation_unresponsive=true WHERE id=$1 AND tenant_id=$2
   AND NOT EXISTS(SELECT 1 FROM whatsapp_messages WHERE lead_id=$1 AND tenant_id=$2 AND direction='inbound' AND sent_at>$3)`, [e.lead_id,e.tenant_id,e.enrolled_at]);
 }
 await activity(client,e,next ? 'Follow-up scheduled' : 'Sequence steps finished',next ? `Next step in ${next.delay_minutes} minutes.` : 'No further sends scheduled.');
}
async function hold(client,e,status,reason,attemptStatus=status) {
 await client.query(`UPDATE automation_enrollments SET status=$2,last_error=$3,claim_token=NULL,claim_until=NULL WHERE id=$1`,[e.id,status,reason]);
 await client.query(`UPDATE automation_send_attempts SET status=$3,error=$4,updated_at=now() WHERE enrollment_id=$1 AND step_order=$2`,[e.id,e.current_step,attemptStatus,reason]);
 await activity(client,e,`Automation ${status}`,reason);
}
function createRunner(deps = {}) {
 const db = deps.db || { query, transaction };
 const textSend = deps.sendTextMessage || sendTextMessage;
 const templateSend = deps.sendTemplate || sendTemplate;
 const emailSend = deps.sendEmail || sendEmail;
 const templatesList = deps.listMessageTemplates || listMessageTemplates;
 const aiGenerate = deps.generateFollowUpMessage || generateFollowUpMessage;
 return async function runAutomationSequences() {
  const token = randomUUID();
  const claimed = await db.transaction(async client => client.query(`WITH due AS (
   SELECT e.id FROM automation_enrollments e JOIN leads l ON l.id=e.lead_id AND l.tenant_id=e.tenant_id
   JOIN automation_sequences s ON s.id=e.sequence_id AND s.tenant_id=e.tenant_id
   WHERE e.status='active' AND e.next_send_at<=now() AND (e.claim_until IS NULL OR e.claim_until<now())
   AND NOT COALESCE(l.ai_paused,false) AND s.is_active=true
   ORDER BY e.next_send_at LIMIT 50 FOR UPDATE OF e SKIP LOCKED)
   UPDATE automation_enrollments e SET claim_token=$1,claim_until=now()+interval '15 minutes'
   FROM due WHERE e.id=due.id RETURNING e.*,e.id AS enrollment_id`,[token]));
  for (const row of claimed.rows) {
   try {
    const state = await db.query(`SELECT l.*,(SELECT MAX(sent_at) FROM whatsapp_messages WHERE tenant_id=l.tenant_id AND lead_id=l.id AND direction='inbound') AS last_inbound,t.settings AS tenant_settings,t.name AS tenant_name,t.email AS tenant_email
     FROM leads l JOIN tenants t ON t.id=l.tenant_id WHERE l.id=$1 AND l.tenant_id=$2`,[row.lead_id,row.tenant_id]);
    const lead = state.rows[0]; if (!lead) continue;
    const settings = lead.tenant_settings || {};
    const steps = (await db.query('SELECT * FROM automation_sequence_steps WHERE sequence_id=$1 AND tenant_id=$2 ORDER BY step_order',[row.sequence_id,row.tenant_id])).rows;
    const step = steps[row.current_step];
    if (!step) {
     await db.query(`UPDATE automation_enrollments SET status='blocked',last_error='Current step is missing. Restore the sequence step before retrying.',claim_token=NULL,claim_until=NULL WHERE id=$1 AND claim_token=$2`,[row.id,token]); continue;
    }
    const attempt = (await db.query(`INSERT INTO automation_send_attempts(tenant_id,enrollment_id,step_order)
     VALUES($1,$2,$3) ON CONFLICT(enrollment_id,step_order) DO UPDATE SET enrollment_id=EXCLUDED.enrollment_id RETURNING *`,[row.tenant_id,row.id,row.current_step])).rows[0];
    if (['sending','uncertain'].includes(attempt.status)) {
     await db.transaction(async client => {await client.query(LEAD_STATE_SQL,[row.lead_id,row.tenant_id]);const e=await enrollmentState(client,row);if(e?.claim_token===token&&e.status==='active')await hold(client,e,'uncertain','Previous delivery outcome is unknown. Reconcile before resending.');});continue;
    }
    if (attempt.status === 'sent') {
     await db.transaction(async client => {await client.query(LEAD_STATE_SQL,[row.lead_id,row.tenant_id]);const e=await enrollmentState(client,row);if(e?.claim_token===token&&e.status==='active')await finishStep(client,e,step,steps,attempt.wa_message_id);});continue;
    }
    if (!isWithinBusinessHours(settings,new Date())) {
     await db.query('UPDATE automation_enrollments SET next_send_at=$1,claim_token=NULL,claim_until=NULL WHERE id=$2 AND claim_token=$3',[nextBusinessWindowStart(settings,new Date()),row.id,token]);continue;
    }
    let list = null, media = null, aiMessage = null;
    if (step.approved_template_name) {
     list = settings.whatsapp_business_account_id && settings.whatsapp_access_token ? await templatesList(settings.whatsapp_business_account_id,settings.whatsapp_access_token) : {success:false,transient:false,error:'WhatsApp template catalogue connection is missing.'};
     const language = step.template_language || list?.templates?.find(t=>t.name===step.approved_template_name)?.language;
     const result=await db.query('SELECT media_type,media_url FROM whatsapp_template_media WHERE tenant_id=$1 AND template_name=$2 AND language=$3',[row.tenant_id,step.approved_template_name,language]);
     if(result.rows[0])media={type:result.rows[0].media_type.toLowerCase(),link:result.rows[0].media_url};
    }
    if (step.ai_generated && !step.always_template && lead.last_inbound && Date.now()-new Date(lead.last_inbound).getTime()<86400000) {
     const history=(await db.query('SELECT direction,message FROM whatsapp_messages WHERE tenant_id=$1 AND lead_id=$2 ORDER BY sent_at DESC LIMIT 10',[row.tenant_id,row.lead_id])).rows.reverse();
     aiMessage=await aiGenerate({leadName:lead.name,tenantName:lead.tenant_name,businessDescription:settings.business_description,instructions:step.ai_instructions,conversationHistory:history});
    }
    // Durable send intent before network I/O. A crash after this point cannot
    // cause an automatic resend, even if the subsequent DB transaction rolls back.
    const intent=await db.query(`UPDATE automation_send_attempts a SET status='sending',updated_at=now() WHERE a.id=$1
     AND a.status NOT IN ('sending','sent','uncertain') AND EXISTS(SELECT 1 FROM automation_enrollments e WHERE e.id=a.enrollment_id AND e.claim_token=$2 AND e.claim_until>now() AND e.status='active') RETURNING a.id`,[attempt.id,token]);
    if(!intent.rows.length)continue;
    await db.transaction(async client => {
     const currentLead=(await client.query(LEAD_STATE_SQL,[row.lead_id,row.tenant_id])).rows[0];
     const e=await enrollmentState(client,row);
     if (!e || e.claim_token!==token || e.status!=='active') {
      return;
     }
     const liveSteps=(await client.query('SELECT * FROM automation_sequence_steps WHERE sequence_id=$1 AND tenant_id=$2 ORDER BY step_order',[e.sequence_id,e.tenant_id])).rows;
     if(e.current_step!==row.current_step || liveSteps[e.current_step]?.id!==step.id){await client.query(`UPDATE automation_send_attempts SET status='ready' WHERE id=$1`,[attempt.id]);await client.query(`UPDATE automation_enrollments SET claim_token=NULL,claim_until=NULL WHERE id=$1`,[e.id]);return;}
     const reason=stopReason(currentLead,e.stop_conditions);
     if(reason){await client.query(`UPDATE automation_enrollments SET status='cancelled',cancelled_at=now(),cancelled_reason=$2,claim_token=NULL,claim_until=NULL,awaiting_step=NULL WHERE id=$1`,[e.id,reason]);await client.query(`UPDATE automation_send_attempts SET status='ready' WHERE id=$1`,[attempt.id]);return;}
     if(currentLead.ai_paused || currentLead.automation_unresponsive || !e.sequence_active){await client.query(`UPDATE automation_enrollments SET claim_token=NULL,claim_until=NULL WHERE id=$1`,[e.id]);await client.query(`UPDATE automation_send_attempts SET status='ready' WHERE id=$1`,[attempt.id]);return;}
     const liveSettings=e.tenant_settings || {};
     if (!isWithinBusinessHours(liveSettings,new Date())) {await client.query('UPDATE automation_enrollments SET next_send_at=$2,claim_token=NULL,claim_until=NULL WHERE id=$1',[e.id,nextBusinessWindowStart(liveSettings,new Date())]);await client.query(`UPDATE automation_send_attempts SET status='ready' WHERE id=$1`,[attempt.id]);return;}
     if(liveSettings.automation_daily_cap_enabled){const count=(await client.query(`SELECT count(*) AS n FROM whatsapp_messages WHERE tenant_id=$1 AND lead_id=$2 AND is_automated=true AND sent_at>=CURRENT_DATE`,[e.tenant_id,e.lead_id])).rows[0];if(Number(count.n)>=(liveSettings.automation_daily_cap || 1)){await client.query(`UPDATE automation_enrollments SET next_send_at=now()+interval '1 day',claim_token=NULL,claim_until=NULL WHERE id=$1`,[e.id]);await client.query(`UPDATE automation_send_attempts SET status='ready' WHERE id=$1`,[attempt.id]);return;}}
     const sessionOpen=currentLead.last_inbound && Date.now()-new Date(currentLead.last_inbound).getTime()<86400000;
     let message=substituteVars(step.message || '',currentLead), plan=null, send;
     const credentials=liveSettings.whatsapp_phone_number_id&&liveSettings.whatsapp_access_token?{phone_number_id:liveSettings.whatsapp_phone_number_id,access_token:liveSettings.whatsapp_access_token}:null;
     if(step.channel==='whatsapp'){
      if(!currentLead.phone){await hold(client,e,'blocked','Lead has no WhatsApp phone number.');return;}
      if(['whatsapp_phone_number_id','whatsapp_access_token','whatsapp_business_account_id'].some(key=>liveSettings[key]!==settings[key])){await hold(client,e,'blocked','WhatsApp connection changed while preparing this step. Retry with the current connection.');return;}
      if(!credentials){await hold(client,e,'blocked','Workspace WhatsApp connection is missing.');return;}
      if(step.always_template || !sessionOpen){
       if(!step.approved_template_name){await hold(client,e,'blocked','An approved template is required outside the WhatsApp messaging window.');return;}
       if(!list?.success || list.stale){
        if(list?.transient===false){await hold(client,e,'blocked',list.error || 'Template catalogue connection needs attention.');return;}
        const n=attempt.attempts+1;await client.query(`UPDATE automation_send_attempts SET attempts=$2 WHERE id=$1`,[attempt.id,n]);
        const outcome=sendOutcome({success:false,transient:true,error:'Template catalogue lookup failed.'},n);
        if(outcome.status==='retry'){await client.query(`UPDATE automation_send_attempts SET status='retry',error=$2 WHERE id=$1`,[attempt.id,outcome.reason]);await client.query(`UPDATE automation_enrollments SET last_error=$2,next_send_at=now()+($3||' minutes')::interval,claim_token=NULL,claim_until=NULL WHERE id=$1`,[e.id,outcome.reason,outcome.minutes]);}else await hold(client,e,'failed',outcome.reason);return;
       }
       plan=templatePlan(step,list.templates,currentLead,media);
       if(plan.blocked){await hold(client,e,'blocked',plan.blocked);return;}
       const consent=decideConsent({lead:currentLead,category:templateCategory(plan.template),hasInbound:!!currentLead.last_inbound,hasBooking:currentLead.has_booking});
       if(!consent.allowed){await hold(client,e,'blocked',consent.reason);await client.query('UPDATE automation_enrollments SET blocked_reason=$2 WHERE id=$1',[e.id,templateCategory(plan.template)==='MARKETING'?'blocked_no_opt_in':'blocked_no_consent']);return;}
       message=plan.message;send=()=>templateSend(currentLead.phone,step.approved_template_name,plan.language,plan.parameters,credentials,media);
      }else{
       if(step.ai_generated){if(!aiMessage){await hold(client,e,'blocked','AI generation failed. Retry this step or provide a fixed message.');return;}message=aiMessage;}
       if(!message.trim()){await hold(client,e,'blocked','Free-text message is empty.');return;}
       send=()=>textSend(currentLead.phone,message,credentials);
      }
     }else{
      if(!currentLead.email){await hold(client,e,'blocked','Lead has no email address.');return;}
      send=async()=>{const result=await emailSend({to:currentLead.email,subject:substituteVars(step.email_subject || `Message from ${e.tenant_name}`,currentLead),text:message,fromName:e.tenant_name,replyTo:liveSettings.email_reply_to || e.tenant_email});return{...result,wa_message_id:result?.messageId};};
     }
     const n=attempt.attempts+1;
     await client.query(`UPDATE automation_send_attempts SET attempts=$2 WHERE id=$1`,[attempt.id,n]);
     let result;try{result=await send();}catch(error){result={success:false,uncertain:true,error:'Provider call threw; delivery may have happened. '+error.message};}
     const outcome=sendOutcome(result,n);
     if(outcome.status==='sent'){
      if(step.channel==='whatsapp')await client.query(`INSERT INTO whatsapp_messages(tenant_id,lead_id,direction,message,message_type,template_name,wa_message_id,status,is_automated,is_ai_generated) VALUES($1,$2,'outbound',$3,$4,$5,$6,'sent',true,$7)`,[e.tenant_id,e.lead_id,message,plan?'template':'text',plan?step.approved_template_name:null,result.wa_message_id,!!step.ai_generated&&!plan]);
      await finishStep(client,e,step,steps,result.wa_message_id);
     }else if(outcome.status==='retry'){
      await client.query(`UPDATE automation_send_attempts SET status='retry',error=$2,updated_at=now() WHERE id=$1`,[attempt.id,outcome.reason]);
      await client.query(`UPDATE automation_enrollments SET last_error=$2,next_send_at=now()+($3||' minutes')::interval,claim_token=NULL,claim_until=NULL WHERE id=$1`,[e.id,outcome.reason,outcome.minutes]);
      await activity(client,e,'Send retry scheduled',outcome.reason);
     }else await hold(client,e,outcome.status,outcome.reason);
    });
   }catch(error){
    // Leave the claim to expire: if intent was persisted, the recovery tick
    // blocks as uncertain. A DB failure must never silently repeat a send.
    console.error('[AutomationRunner] step failed:',error.message);
   }
  }
 };
}
const runAutomationSequences=createRunner();
module.exports={runAutomationSequences,createRunner,isWithinBusinessHours,nextBusinessWindowStart,LEAD_STATE_SQL,enrollmentState,finishStep};
