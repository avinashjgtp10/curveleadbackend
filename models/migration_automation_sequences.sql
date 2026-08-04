-- ============================================
-- Automated Trigger Sequences Migration - Run in pgAdmin on RDS curvelead database
-- ============================================

CREATE TABLE IF NOT EXISTS automation_sequences (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(200) NOT NULL,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_automation_sequences_tenant ON automation_sequences(tenant_id);

-- step_order is 0-based; delay_minutes is relative to the previous step
-- (or to enrollment time, for step 0)
CREATE TABLE IF NOT EXISTS automation_sequence_steps (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id   UUID NOT NULL REFERENCES automation_sequences(id) ON DELETE CASCADE,
  step_order    INT NOT NULL,
  delay_minutes INT NOT NULL DEFAULT 0,
  channel       VARCHAR(20) NOT NULL DEFAULT 'whatsapp', -- whatsapp, email
  message       TEXT NOT NULL,
  email_subject VARCHAR(255),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_automation_steps_sequence ON automation_sequence_steps(sequence_id, step_order);

CREATE TABLE IF NOT EXISTS automation_rules (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         VARCHAR(200) NOT NULL,
  trigger_type VARCHAR(30) NOT NULL, -- new_lead, stage_change
  stage_name   VARCHAR(50),          -- only used when trigger_type = 'stage_change'
  sequence_id  UUID NOT NULL REFERENCES automation_sequences(id) ON DELETE CASCADE,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_tenant ON automation_rules(tenant_id, trigger_type, is_active);

CREATE TABLE IF NOT EXISTS automation_enrollments (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sequence_id  UUID NOT NULL REFERENCES automation_sequences(id) ON DELETE CASCADE,
  rule_id      UUID REFERENCES automation_rules(id) ON DELETE SET NULL,
  current_step INT NOT NULL DEFAULT 0,
  status       VARCHAR(20) NOT NULL DEFAULT 'active', -- active, completed, cancelled
  enrolled_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  next_send_at TIMESTAMP,
  completed_at TIMESTAMP,
  cancelled_at TIMESTAMP
);

-- A lead is enrolled in a given sequence at most once, ever
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_enrollments_unique ON automation_enrollments(tenant_id, lead_id, sequence_id);
CREATE INDEX IF NOT EXISTS idx_automation_enrollments_due ON automation_enrollments(status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_automation_enrollments_lead ON automation_enrollments(tenant_id, lead_id);
