-- Ads & Social Phase 7a: Google Ads (read). Additive only; safe to re-run.
-- Google Ads data uses the existing ad_* tables with provider = 'google':
-- customer → ad_accounts, campaign → ad_campaigns, ad group → ad_adsets, ad → ad_ads,
-- daily cost/clicks/conversions → ad_insights_daily.
BEGIN;

-- A client account reached through a manager (MCC) account needs the manager's id on
-- every API call (login-customer-id).
ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS login_customer_id text;

-- CRM campaign ↔ Google Ads campaign, like meta_campaign_id.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS google_campaign_id text;
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_tenant_google_campaign
  ON campaigns (tenant_id, google_campaign_id) WHERE google_campaign_id IS NOT NULL;

-- Lead-form leads already carry google_campaign_id; this makes linking them fast.
CREATE INDEX IF NOT EXISTS leads_tenant_google_campaign
  ON leads (tenant_id, google_campaign_id) WHERE google_campaign_id IS NOT NULL;

COMMIT;
