-- ============================================
-- Meta Ads Manager Integration Migration - Run in pgAdmin on RDS curvelead database
-- ============================================

-- Part A: reliable lead -> campaign attribution
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meta_campaign_id VARCHAR(50);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS meta_adset_id VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_meta_campaign_id
  ON campaigns(tenant_id, meta_campaign_id) WHERE meta_campaign_id IS NOT NULL;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_ad_id VARCHAR(50);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_adset_id VARCHAR(50);

-- Part B: ad spend & performance sync (added now so both parts ship in one migration)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS impressions INT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS clicks INT;
