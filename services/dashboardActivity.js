const {query}=require('../config/db');
// All dashboard counters and their lead drill-downs use these predicates and workspace boundaries.
function predicates(today,month,week) { return {
 new_today:`l.created_at>=${today}`,
 contacted_today:`l.created_at>=${today} AND l.first_response_at IS NOT NULL`,
 meta_today:`l.source='meta_ads' AND l.created_at>=${today}`,
 active_sequence:`EXISTS(SELECT 1 FROM automation_enrollments e WHERE e.tenant_id=l.tenant_id AND e.lead_id=l.id AND e.status='active')`,
 completed_sequence:`EXISTS(SELECT 1 FROM automation_enrollments e WHERE e.tenant_id=l.tenant_id AND e.lead_id=l.id AND e.status='completed' AND e.completed_at>=${month})`,
 ai_replies:`EXISTS(SELECT 1 FROM whatsapp_messages m WHERE m.tenant_id=l.tenant_id AND m.lead_id=l.id AND m.is_ai_generated=true AND m.sent_at>=${week})`,
 automated_sends:`EXISTS(SELECT 1 FROM whatsapp_messages m WHERE m.tenant_id=l.tenant_id AND m.lead_id=l.id AND m.is_automated=true AND m.sent_at>=${week})`,
 opt_outs:`l.opted_out_at>=${week}`,
 escalations:`EXISTS(SELECT 1 FROM notifications n WHERE n.tenant_id=l.tenant_id AND n.reference_type='lead' AND n.reference_id=l.id AND n.type IN ('lead_escalation','ai_handoff') AND n.created_at>=${week})`,
 automation_replies:`EXISTS(SELECT 1 FROM whatsapp_messages m WHERE m.tenant_id=l.tenant_id AND m.lead_id=l.id AND m.direction='inbound' AND m.sent_at>=${week} AND EXISTS(SELECT 1 FROM whatsapp_messages p WHERE p.tenant_id=m.tenant_id AND p.lead_id=m.lead_id AND p.is_automated=true AND p.sent_at<m.sent_at AND p.sent_at>=${week}))`
 }; }
async function boundaries(tenantId){return (await query(`SELECT date_trunc('day',now() AT TIME ZONE tz) AT TIME ZONE tz AS today,
 date_trunc('month',now() AT TIME ZONE tz) AT TIME ZONE tz AS month,now()-interval '7 days' AS week
 FROM (SELECT COALESCE(settings->>'timezone','Asia/Kolkata') tz FROM tenants WHERE id=$1)t`,[tenantId])).rows[0];}
async function counts(tenantId,staffId){
 const b=await boundaries(tenantId),p=predicates('$3','$4','$5');
 const r=await query(`SELECT ${Object.entries(p).map(([key,sql])=>`count(*) FILTER(WHERE ${sql})::int AS ${key}`).join(',')}
 FROM leads l WHERE l.tenant_id = $1 AND l.merged_into_id IS NULL AND ($2::uuid IS NULL OR l.assigned_to=$2)`,[tenantId,staffId,b.today,b.month,b.week]);return r.rows[0];
}
module.exports={predicates,boundaries,counts};
