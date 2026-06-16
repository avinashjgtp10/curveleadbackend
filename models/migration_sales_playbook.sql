-- Run this on RDS
-- Self-updating sales playbook, mined from call_recordings + ai_voice_calls analysis

CREATE TABLE IF NOT EXISTS sales_playbooks (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          UUID REFERENCES tenants(id) ON DELETE CASCADE,
  version            INT NOT NULL DEFAULT 1,
  best_practices     JSONB,
  common_objections  JSONB,
  phrases_that_work  JSONB,
  phrases_to_avoid   JSONB,
  source_call_count  INT DEFAULT 0,
  source_won_count   INT DEFAULT 0,
  source_lost_count  INT DEFAULT 0,
  generated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_playbooks_tenant ON sales_playbooks(tenant_id, version DESC);
