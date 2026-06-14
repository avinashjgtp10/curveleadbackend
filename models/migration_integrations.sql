-- ============================================
-- Integrations Migration - Run in pgAdmin on RDS curvelead database
-- ============================================

-- Add settings JSONB column to tenants if not exists
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';

-- Add meta_lead_id column to leads if not exists (used by Meta webhook)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_lead_id VARCHAR(100);

-- Update any tenants with NULL settings to empty object
UPDATE tenants SET settings = '{}' WHERE settings IS NULL;
