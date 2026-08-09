-- ============================================
-- Lead assignment rules migration - Run in pgAdmin on RDS curvelead database
-- ============================================
-- Auto-assigns new leads to a user (or round-robins across a team) based on
-- source / campaign / location, optionally kicking off a follow-up sequence.

CREATE TABLE IF NOT EXISTS assignment_rules (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                   VARCHAR(200) NOT NULL,
  priority               INTEGER NOT NULL DEFAULT 0, -- lower runs first; first match wins
  is_active              BOOLEAN NOT NULL DEFAULT true,

  -- Match conditions (all provided ones must match; empty/null means "any")
  sources                VARCHAR(50)[],   -- matches leads.source
  campaign_ids           UUID[],          -- matches leads.campaign_id
  location_contains      VARCHAR(200),    -- case-insensitive substring match against leads.location

  -- Assignment target — exactly one of these is set
  assign_to_user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  assign_to_team_id      UUID REFERENCES teams(id) ON DELETE CASCADE,
  last_assigned_user_id  UUID REFERENCES users(id) ON DELETE SET NULL, -- round-robin cursor for team targets

  -- Optional: enroll the lead in this sequence once assigned
  sequence_id            UUID REFERENCES automation_sequences(id) ON DELETE SET NULL,

  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_assignment_rules_tenant ON assignment_rules(tenant_id, priority);
