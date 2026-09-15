-- AI-Personalized Follow-Up Steps
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_ai_followup_steps.sql

-- Marks a WhatsApp automation step as AI-composed: instead of sending
-- `message` verbatim (after {{var}} substitution), the runner asks Groq to
-- write the outbound text, using `ai_instructions` as guidance. Ignored for
-- 'email' steps in v1 (email-channel steps always use `message` as today).
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN NOT NULL DEFAULT false;

-- Optional business-owner guidance for the AI when ai_generated = true
-- (e.g. "mention our new autumn discount, keep it under 3 lines"). NULL/blank
-- is valid — the AI falls back to a generic friendly check-in. `message` is
-- ignored by the runner whenever ai_generated = true (not deleted, just unused).
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS ai_instructions TEXT;
