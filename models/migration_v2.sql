-- ============================================
-- CurveLead V1 → V2 Migration
-- Run in pgAdmin on existing curvelead database
-- KEEPS: tenants, users, leads, lead_stages, followups, plans, notifications
-- REMOVES: students, courses, batches, attendance, fees, payments, salary, expenses
-- ADDS: campaigns, whatsapp_messages, lead scoring columns
-- ============================================

BEGIN;

-- ============================================
-- 1. ADD NEW COLUMNS TO EXISTING TABLES
-- ============================================

-- Add lead scoring to leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_score VARCHAR(20) DEFAULT 'warm';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id UUID;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE leads ADD COLUMN IF NOT EXISTS won_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMP;

-- Add business_type to tenants if not exists
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_type VARCHAR(50) DEFAULT 'lead_management';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;

-- ============================================
-- 2. CREATE NEW TABLES
-- ============================================

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    source VARCHAR(50) NOT NULL,
    description TEXT,
    budget DECIMAL(12,2) DEFAULT 0,
    actual_spend DECIMAL(12,2) DEFAULT 0,
    start_date DATE,
    end_date DATE,
    status VARCHAR(20) DEFAULT 'active',
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(100),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, status);

-- Add FK from leads to campaigns
DO $$ BEGIN
    ALTER TABLE leads ADD CONSTRAINT fk_leads_campaign 
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- WhatsApp Messages
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text',
    media_url TEXT,
    template_name VARCHAR(100),
    wa_message_id VARCHAR(200),
    status VARCHAR(20) DEFAULT 'sent',
    is_ai_generated BOOLEAN DEFAULT false,
    sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_tenant ON whatsapp_messages(tenant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_lead ON whatsapp_messages(lead_id, sent_at);

-- ============================================
-- 3. UPDATE INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(tenant_id, lead_score);

-- ============================================
-- 4. DROP UNUSED TABLES (legacy, tenant-specific)
-- WARNING: This deletes all legacy tenant data!
-- Uncomment only after backup!
-- ============================================

-- DROP TABLE IF EXISTS payments CASCADE;
-- DROP TABLE IF EXISTS fee_installments CASCADE;
-- DROP TABLE IF EXISTS student_fees CASCADE;
-- DROP TABLE IF EXISTS student_attendance CASCADE;
-- DROP TABLE IF EXISTS students CASCADE;
-- DROP TABLE IF EXISTS batches CASCADE;
-- DROP TABLE IF EXISTS courses CASCADE;
-- DROP TABLE IF EXISTS expenses CASCADE;
-- DROP TABLE IF EXISTS salaries CASCADE;
-- DROP TABLE IF EXISTS staff_attendance CASCADE;
-- DROP TABLE IF EXISTS invoices CASCADE;
-- DROP TABLE IF EXISTS templates CASCADE;

-- ============================================
-- 5. UPDATE EXISTING DATA
-- ============================================

-- Set default lead_score for existing leads based on stage
UPDATE leads SET lead_score = 
  CASE 
    WHEN stage IN ('enrolled', 'won') THEN 'hot'
    WHEN stage IN ('interested', 'counselling', 'negotiation') THEN 'warm'
    WHEN stage IN ('dropped', 'lost') THEN 'cold'
    ELSE 'warm'
  END
WHERE lead_score IS NULL;

-- Set business_type for existing tenants
UPDATE tenants SET business_type = 'lead_management' WHERE business_type IS NULL;

COMMIT;

-- ============================================
-- POST-MIGRATION CHECK
-- ============================================
SELECT 'Migration completed!' as status;
SELECT 'Leads with scores:' as info, COUNT(*) FROM leads WHERE lead_score IS NOT NULL;
SELECT 'Tenants:' as info, COUNT(*) FROM tenants;
SELECT 'Users:' as info, COUNT(*) FROM users;
SELECT 'Campaigns table exists' as info, COUNT(*) FROM campaigns;
SELECT 'WhatsApp messages table exists' as info, COUNT(*) FROM whatsapp_messages;
