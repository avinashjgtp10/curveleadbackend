-- Dismissal keeps appointment history without counting it as actionable work.
ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_followups_actionable ON lead_followups(tenant_id,next_followup_at)
 WHERE is_completed=false AND dismissed_at IS NULL;
