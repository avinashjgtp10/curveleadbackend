-- Leads list speed - run once on the curvelead database (safe to re-run).
-- The list looks up each lead's next pending follow-up; without this index every lead scans the follow-ups table.
CREATE INDEX IF NOT EXISTS idx_lead_followups_pending_by_lead
  ON lead_followups (lead_id, next_followup_at)
  WHERE is_completed = false AND dismissed_at IS NULL;

-- Stage lookup by name (the list joins lead_stages on LOWER(name) for each lead).
CREATE INDEX IF NOT EXISTS idx_lead_stages_tenant_lower_name ON lead_stages (tenant_id, LOWER(name));
