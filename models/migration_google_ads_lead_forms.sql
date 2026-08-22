-- ============================================
-- Google Ads Lead Form integration migration - Run in pgAdmin on RDS curvelead database
-- ============================================
-- Per-workspace Google Ads Lead Form Asset webhook integrations. Each row is one
-- webhook URL + key pair a tenant can paste into Google Ads → Lead Form Asset →
-- "Other data integration options". Superseded (but does not replace) the older
-- single-secret /api/webhook/google flow, whose settings live in tenants.settings.

CREATE TABLE IF NOT EXISTS google_ads_integrations (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                     VARCHAR(150) NOT NULL DEFAULT 'Google Ads Lead Form',

  -- AES-256-GCM ciphertext (base64: iv + authTag + ciphertext) — see utils/cryptoSecrets.js.
  -- Never store or log the plaintext key.
  webhook_key_encrypted    TEXT NOT NULL,

  -- Defaults applied to every live lead this integration creates
  default_group            VARCHAR(100),               -- pushed into leads.tags
  default_stage            VARCHAR(50),                 -- matches lead_stages.name; NULL = tenant's first active stage
  assigned_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_team_id         UUID REFERENCES teams(id) ON DELETE SET NULL,
  last_assigned_user_id    UUID REFERENCES users(id) ON DELETE SET NULL, -- round-robin cursor for assigned_team_id
  product                  VARCHAR(100),

  test_lead_behavior       VARCHAR(20) NOT NULL DEFAULT 'create_labeled_lead', -- create_labeled_lead | log_only
  is_active                BOOLEAN NOT NULL DEFAULT true,

  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_test_received_at    TIMESTAMP,
  last_live_lead_received_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_google_ads_integrations_tenant ON google_ads_integrations(tenant_id);

-- Attribution + dedup columns on leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_lead_id VARCHAR(150);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gclid VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_campaign_id VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_form_id VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_adgroup_id VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_creative_id VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_asset_group_id VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_submit_time TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_test_lead BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_custom_answers JSONB DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_ads_integration_id UUID REFERENCES google_ads_integrations(id) ON DELETE SET NULL;

-- Equivalent of a (workspace_id, provider, external_lead_id) uniqueness constraint —
-- google_lead_id is itself provider-specific, so (tenant_id, google_lead_id) suffices.
-- A retried Google webhook delivery for the same lead_id hits this constraint via
-- ON CONFLICT DO NOTHING rather than creating a duplicate lead. Being a partial index,
-- any ON CONFLICT targeting it must repeat this same WHERE predicate for Postgres to
-- infer it — see googleAdsIntegrationController.js's lead INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_google_lead_dedup
  ON leads(tenant_id, google_lead_id) WHERE google_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_is_test ON leads(tenant_id, is_test_lead) WHERE is_test_lead = true;
