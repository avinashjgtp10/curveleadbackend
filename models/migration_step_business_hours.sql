-- Per-step "only send during business hours" (judged in the lead's local time zone).
-- Additive and off by default: existing steps behave exactly as before. Safe to run more than once.
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS business_hours_only BOOLEAN NOT NULL DEFAULT false;
