-- Phase 1 / reporting shadow log: while a workspace's cohort reporting is in 'shadow' mode, each cohort request also
-- computes the legacy figures and records the difference here, so the two models can be compared before anyone switches.
-- NOT APPLIED TO ANY DATABASE. One additive table. Rollback: DROP TABLE metric_shadow_log.
CREATE TABLE IF NOT EXISTS metric_shadow_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric     text NOT NULL,
  scope      jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy     numeric,
  cohort     numeric,
  delta      numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metric_shadow_log_tenant_idx ON metric_shadow_log (tenant_id, created_at DESC);
