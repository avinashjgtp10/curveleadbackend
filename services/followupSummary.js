const { query } = require('../config/db');
const active = `f.is_completed=false AND f.dismissed_at IS NULL AND f.next_followup_at IS NOT NULL
 AND lower(trim(l.stage)) NOT IN ('lost','unqualified','disqualified')
 AND NOT EXISTS (SELECT 1 FROM lead_stages s WHERE s.tenant_id=l.tenant_id AND lower(s.name)=lower(l.stage) AND s.is_lost=true)`;
const overdue = `${active} AND f.next_followup_at < NOW()`;
async function summary(tenantId, staffId=null) {
 const r = await query(`SELECT
 count(*) FILTER (WHERE ${overdue})::int AS overdue,
 count(*) FILTER (WHERE ${active} AND (f.next_followup_at AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(t.settings->>'timezone','Asia/Kolkata'))::date=(now() AT TIME ZONE COALESCE(t.settings->>'timezone','Asia/Kolkata'))::date)::int AS today,
 count(*) FILTER (WHERE ${active} AND f.followup_type='demo' AND (f.next_followup_at AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(t.settings->>'timezone','Asia/Kolkata'))::date=(now() AT TIME ZONE COALESCE(t.settings->>'timezone','Asia/Kolkata'))::date)::int AS demos_today,
 count(*) FILTER (WHERE ${active} AND f.next_followup_at>=now())::int AS upcoming,
 count(*) FILTER (WHERE ${active} AND f.next_followup_at<now()-interval '48 hours' AND f.next_followup_at>=now()-interval '120 hours')::int AS missed,
 count(*) FILTER (WHERE ${active} AND f.next_followup_at<now()-interval '120 hours')::int AS critical,
 count(*) FILTER (WHERE ${active} AND f.next_followup_at<now()-interval '7 days')::int AS stale
 FROM lead_followups f JOIN leads l ON l.id=f.lead_id AND l.tenant_id=f.tenant_id
 JOIN tenants t ON t.id=f.tenant_id WHERE f.tenant_id=$1 AND ($2::uuid IS NULL OR l.assigned_to=$2)`, [tenantId,staffId]);
 return r.rows[0];
}
module.exports={active,overdue,summary};
