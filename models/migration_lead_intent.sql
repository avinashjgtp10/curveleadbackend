-- Phase 2 of the Lead Intent Index: numeric AI score + suggested action.
-- score_reason and score_updated_at already exist (see leads table in schema.sql).
-- Run in pgAdmin on your RDS database

ALTER TABLE leads ADD COLUMN IF NOT EXISTS intent_score INT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS suggested_action TEXT;
