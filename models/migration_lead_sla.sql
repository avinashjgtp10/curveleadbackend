-- Lead Response SLA tracking (Phase 1)
-- SLA clock starts at created_at (system timestamp), NOT lead_date (user-editable/backdatable).
-- Run in pgAdmin on your RDS database

ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_response_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_response_type VARCHAR(30);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS response_time_seconds INTEGER;

CREATE INDEX IF NOT EXISTS idx_leads_sla ON leads(tenant_id, first_response_at, created_at);

-- Backfill: earliest non-'created' lead_activities row per lead = inferred first response.
-- Leads with no such row are left NULL (correctly read as still-uncontacted).
UPDATE leads l
SET first_response_at = a.created_at,
    first_response_by = a.created_by,
    first_response_type = a.activity_type,
    response_time_seconds = GREATEST(0, EXTRACT(EPOCH FROM (a.created_at - l.created_at))::INTEGER)
FROM (
  SELECT DISTINCT ON (lead_id) lead_id, tenant_id, created_at, created_by, activity_type
  FROM lead_activities
  WHERE activity_type <> 'created'
  ORDER BY lead_id, created_at ASC
) a
WHERE a.lead_id = l.id
  AND a.tenant_id = l.tenant_id
  AND l.first_response_at IS NULL;
