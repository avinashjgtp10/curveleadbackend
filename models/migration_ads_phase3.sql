-- ============================================
-- Ads module Phase 3: pause/resume + budget changes, with an audit trail.
-- Transactional and safe to rerun.
-- Apply: psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase3.sql
-- The daily budget cap lives in tenants.settings.ads_daily_budget_cap_paise (no column).
-- ============================================
BEGIN;

-- Every change CurveLead makes (or tries to make) to a Meta campaign / ad set.
CREATE TABLE IF NOT EXISTS ad_audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  ad_account_id  uuid REFERENCES ad_accounts(id) ON DELETE SET NULL,
  entity_type    text NOT NULL CHECK (entity_type IN ('campaign','adset','ad')),
  entity_id      text NOT NULL,                -- Meta external id
  entity_name    text,
  action         text NOT NULL CHECK (action IN ('pause','resume','update_budget','create','activate')),
  old_value      jsonb,
  new_value      jsonb,
  request        jsonb,
  response       jsonb,
  success        boolean NOT NULL,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_audit_log_tenant_created ON ad_audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_audit_log_entity ON ad_audit_log (tenant_id, entity_type, entity_id, created_at DESC);

COMMIT;
