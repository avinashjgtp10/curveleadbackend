-- Lead Automation Rules v4 — AI-generated step message support.
-- The controller/runner (automationController.saveSteps, automationSequenceRunner)
-- already read/write these columns, but they were never added to the table —
-- every sequence save was failing with a 500 until this migration.
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_lead_automation_v4.sql

ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS ai_instructions TEXT;
