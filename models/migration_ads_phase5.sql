-- ============================================
-- Ads module Phase 5: AI campaign drafts. Transactional and safe to rerun.
-- Apply: psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase5.sql
-- ============================================
BEGIN;

CREATE TABLE IF NOT EXISTS ad_ai_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  ad_account_id      uuid REFERENCES ad_accounts(id) ON DELETE SET NULL,
  brief              jsonb NOT NULL,           -- what the user asked for
  ai_output          jsonb,                    -- what the model returned (normalised)
  edited             jsonb,                    -- the campaign as the user last saved it
  validation_errors  jsonb NOT NULL DEFAULT '[]',
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','creating','created','activated','failed')),
  image              jsonb,                    -- { hash, url, name } after upload
  meta_ids           jsonb NOT NULL DEFAULT '{}',  -- campaign_id, adset_id, form_id, creative_id, ad_id
  api_log            jsonb NOT NULL DEFAULT '[]',  -- one entry per Meta call (no tokens)
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_ai_drafts_tenant ON ad_ai_drafts (tenant_id, created_at DESC);

COMMIT;
