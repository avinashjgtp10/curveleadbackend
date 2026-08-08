-- ============================================
-- Ad-level performance table - Run in pgAdmin on RDS curvelead database
-- ============================================

CREATE TABLE IF NOT EXISTS meta_ads (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id   UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  meta_ad_id    VARCHAR(50) NOT NULL,
  meta_adset_id VARCHAR(50),
  name          VARCHAR(255),
  spend         DECIMAL(12,2) DEFAULT 0,
  impressions   INT DEFAULT 0,
  clicks        INT DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_ads_unique ON meta_ads(tenant_id, meta_ad_id);
CREATE INDEX IF NOT EXISTS idx_meta_ads_campaign ON meta_ads(campaign_id);
