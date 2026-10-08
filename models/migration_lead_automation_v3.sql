-- Lead Automation Rules v3 — Lead Source / Lead Status triggers,
-- automation activity-timeline events, and rule name on enrollments.
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_lead_automation_v3.sql

-- New trigger discriminators: a rule can fire on a lead's source or lead_status
-- matching a fixed value, alongside the existing stage_name/campaign_id ones.
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS source_value VARCHAR(50);
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS status_value VARCHAR(100);
