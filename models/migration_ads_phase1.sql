-- ============================================
-- Ads module Phase 1: ad accounts, encrypted tokens, campaign → adset → ad
-- hierarchy and daily insights. Transactional and safe to rerun.
-- Apply: psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase1.sql
-- Then:  node scripts/migrateAdTokens.js --dry-run   (and --apply)
-- ============================================
BEGIN;

CREATE TABLE IF NOT EXISTS ad_oauth_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider           text NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta','google')),
  external_user_id   text NOT NULL,            -- Meta user / system user id the token belongs to
  token_encrypted    text NOT NULL,
  key_version        smallint NOT NULL DEFAULT 1,
  scopes             text[] NOT NULL DEFAULT '{}',
  expires_at         timestamptz,              -- NULL = does not expire (system user / business token)
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  last_checked_at    timestamptz,
  last_refreshed_at  timestamptz,
  last_error         text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_user_id)
);

CREATE TABLE IF NOT EXISTS ad_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta','google')),
  external_id      text NOT NULL,              -- 'act_123…' for Meta
  name             text,
  currency         text,
  timezone_name    text,
  account_status   int,
  token_id         uuid REFERENCES ad_oauth_tokens(id) ON DELETE SET NULL,
  is_primary       boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  last_synced_at   timestamptz,
  insights_synced_through date,
  sync_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_accounts_one_primary ON ad_accounts(tenant_id, provider) WHERE is_primary;

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ad_account_id          uuid NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  external_id            text NOT NULL,
  campaign_id            uuid REFERENCES campaigns(id) ON DELETE SET NULL,  -- existing CRM campaign
  name                   text,
  objective              text,
  status                 text,
  effective_status       text,
  daily_budget_paise     bigint,
  lifetime_budget_paise  bigint,
  special_ad_categories  text[] NOT NULL DEFAULT '{}',
  start_time             timestamptz,
  stop_time              timestamptz,
  synced_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS ad_campaigns_account ON ad_campaigns(tenant_id, ad_account_id);

CREATE TABLE IF NOT EXISTS ad_adsets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ad_campaign_id         uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  external_id            text NOT NULL,
  name                   text,
  status                 text,
  effective_status       text,
  daily_budget_paise     bigint,
  lifetime_budget_paise  bigint,
  optimization_goal      text,
  billing_event          text,
  targeting              jsonb,
  promoted_object        jsonb,
  synced_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS ad_adsets_campaign ON ad_adsets(tenant_id, ad_campaign_id);

CREATE TABLE IF NOT EXISTS ad_ads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ad_adset_id        uuid NOT NULL REFERENCES ad_adsets(id) ON DELETE CASCADE,
  external_id        text NOT NULL,
  name               text,
  status             text,
  effective_status   text,
  creative_id        text,
  creative           jsonb,     -- { thumbnail_url, image_url, body, title, call_to_action_type }
  synced_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX IF NOT EXISTS ad_ads_adset ON ad_ads(tenant_id, ad_adset_id);

-- One row per entity per day. Spend/CPL in account currency major units (rupees);
-- ad rows come from Meta, adset/campaign/account rows are rolled up from them.
CREATE TABLE IF NOT EXISTS ad_insights_daily (
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ad_account_id         uuid NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  entity_type           text NOT NULL CHECK (entity_type IN ('account','campaign','adset','ad')),
  entity_id             text NOT NULL,          -- Meta external id
  date                  date NOT NULL,
  spend                 numeric(14,2) NOT NULL DEFAULT 0,
  impressions           bigint NOT NULL DEFAULT 0,
  clicks                bigint NOT NULL DEFAULT 0,
  ctr                   numeric(10,4),
  cpc                   numeric(14,4),
  leads                 int NOT NULL DEFAULT 0,
  cpl                   numeric(14,2),
  actions               jsonb,
  cost_per_action_type  jsonb,
  campaign_external_id  text,
  adset_external_id     text,
  synced_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_type, entity_id, date)
);
CREATE INDEX IF NOT EXISTS ad_insights_daily_account_date ON ad_insights_daily(tenant_id, ad_account_id, entity_type, date);

-- Which pipeline stages count as "qualified" for cost-per-qualified-lead.
-- Default: the stage named Qualified and every later, non-lost stage.
ALTER TABLE lead_stages ADD COLUMN IF NOT EXISTS is_qualified boolean NOT NULL DEFAULT false;
UPDATE lead_stages s SET is_qualified = true
FROM (SELECT tenant_id, min(COALESCE(pos, position)) AS qpos FROM lead_stages
      WHERE lower(trim(name)) = 'qualified' GROUP BY tenant_id) q
WHERE s.tenant_id = q.tenant_id AND COALESCE(s.pos, s.position) >= q.qpos
  AND NOT COALESCE(s.is_lost, false) AND NOT s.is_qualified
  AND NOT EXISTS (SELECT 1 FROM lead_stages x WHERE x.tenant_id = s.tenant_id AND x.is_qualified);

COMMIT;
