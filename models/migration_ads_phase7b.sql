-- Ads & Social Phase 7b: Google Ads controls (pause/resume, budgets) and AI search-ad drafts.
-- Additive only; safe to re-run.
-- Apply: psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase7b.sql
BEGIN;

-- AI drafts for both platforms. Google drafts keep their created resource names in
-- meta_ids (campaign, budget, ad group, ad) — the column predates Google.
ALTER TABLE ad_ai_drafts ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'meta';
DO $$ BEGIN
  ALTER TABLE ad_ai_drafts ADD CONSTRAINT ad_ai_drafts_provider_check CHECK (provider IN ('meta', 'google'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS ad_ai_drafts_tenant_provider ON ad_ai_drafts (tenant_id, provider, created_at DESC);

-- Change history per platform.
ALTER TABLE ad_audit_log ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'meta';
CREATE INDEX IF NOT EXISTS ad_audit_log_tenant_provider ON ad_audit_log (tenant_id, provider, created_at DESC);

-- Google campaign budgets can be shared by several campaigns: the budget cap counts a
-- shared budget once, and CurveLead won't change one (it would move every campaign on it).
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS budget_resource text;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS budget_shared boolean NOT NULL DEFAULT false;

COMMIT;
