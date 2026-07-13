-- Structured follow-up outcome & rescheduling workflow.
-- Extends lead_followups (does not replace it) and adds lead_followup_attempts
-- as a distinct record from the follow-up task itself, per the core principle:
-- a call attempt and a follow-up task are different things.
-- Run in pgAdmin on your RDS database

-- 1. Extend lead_followups with lifecycle status + linkage.
--    is_completed is kept and stays in sync (true whenever a row is closed,
--    regardless of why) so every existing query/filter/reminder job keeps working.
ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'scheduled';
ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;
ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS parent_followup_id UUID REFERENCES lead_followups(id) ON DELETE SET NULL;
ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS rescheduled_to_followup_id UUID REFERENCES lead_followups(id) ON DELETE SET NULL;
ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;

-- Backfill existing rows into the new status vocabulary without losing data.
-- (Only touches rows still at the column default, so re-running this migration is safe.)
UPDATE lead_followups SET status = 'completed', completed_at = COALESCE(completed_at, created_at)
  WHERE is_completed = true AND status = 'scheduled';
UPDATE lead_followups SET status = 'scheduled'
  WHERE is_completed = false AND status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_lead_followups_status ON lead_followups(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_followups_parent ON lead_followups(parent_followup_id);

-- 2. A follow-up attempt is its own record: one row per "Log outcome" submission.
CREATE TABLE IF NOT EXISTS lead_followup_attempts (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  followup_id          UUID NOT NULL REFERENCES lead_followups(id) ON DELETE CASCADE,
  lead_id              UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  attempted_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  attempted_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  outcome              VARCHAR(30) NOT NULL, -- connected, no_answer, busy, unavailable, call_later, rescheduled, wrong_number, not_interested
  conversation_result  VARCHAR(30),          -- qualified, demo_booked, quotation_requested, won, not_interested, needs_followup (only when outcome = connected)
  notes                TEXT,
  next_followup_id     UUID REFERENCES lead_followups(id) ON DELETE SET NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_followup_attempts_followup ON lead_followup_attempts(followup_id);
CREATE INDEX IF NOT EXISTS idx_followup_attempts_lead ON lead_followup_attempts(tenant_id, lead_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_followup_attempts_outcome ON lead_followup_attempts(tenant_id, outcome, attempted_at DESC);
