-- ============================================
-- CurveLead V2 Schema - Lead Management Platform
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Plans (subscription tiers)
CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) UNIQUE NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    max_leads INTEGER DEFAULT 100,
    max_users INTEGER DEFAULT 1,
    features JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tenants (workspaces / businesses)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(150),
    phone VARCHAR(20),
    business_type VARCHAR(50) DEFAULT 'lead_management',
    logo_url TEXT,
    address TEXT,
    plan_id UUID REFERENCES plans(id),
    subscription_status VARCHAR(20) DEFAULT 'trial', -- trial, active, expired, cancelled
    trial_ends_at TIMESTAMP,
    subscription_start DATE,
    subscription_end DATE,
    onboarding_completed BOOLEAN DEFAULT false,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);

-- Users (admins, staff)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    phone VARCHAR(20),
    password_hash TEXT NOT NULL,
    role VARCHAR(20) DEFAULT 'staff', -- super_admin, admin, staff
    avatar_url TEXT,
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lead stages (customizable pipeline per tenant)
CREATE TABLE IF NOT EXISTS lead_stages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    pos INTEGER NOT NULL,
    color VARCHAR(20) DEFAULT 'gray',
    is_won BOOLEAN DEFAULT false,
    is_lost BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lead_stages_tenant ON lead_stages(tenant_id, pos);

-- ⭐ Campaigns (track ad spend + ROI)
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    source VARCHAR(50) NOT NULL, -- meta_ads, google_ads, instagram, whatsapp, organic, referral, other
    description TEXT,
    budget DECIMAL(12,2) DEFAULT 0,
    actual_spend DECIMAL(12,2) DEFAULT 0,
    start_date DATE,
    end_date DATE,
    status VARCHAR(20) DEFAULT 'active', -- draft, active, paused, completed
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(100),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, status);

-- Leads (core entity)
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Contact info
    name VARCHAR(200) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(150),
    location VARCHAR(200),
    
    -- Source & campaign
    source VARCHAR(50) DEFAULT 'manual', -- meta_ads, google_ads, whatsapp, referral, manual, website, walkin
    source_detail VARCHAR(200), -- specific ad/campaign name
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    
    -- Pipeline
    stage VARCHAR(50) DEFAULT 'new',
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    
    -- AI scoring (new + warm + hot + cold)
    lead_score VARCHAR(20) DEFAULT 'warm', -- hot, warm, cold
    score_reason TEXT,
    score_updated_at TIMESTAMP,
    
    -- Deal value (quoted price)
    deal_value DECIMAL(12,2) DEFAULT 0,
    advance_received DECIMAL(12,2) DEFAULT 0, -- collected once lead is Won
    expected_close_date DATE,
    
    -- Meta tracking
    meta_lead_id VARCHAR(100),
    notes TEXT,
    tags TEXT[],
    
    -- Won/Lost
    won_at TIMESTAMP,
    lost_at TIMESTAMP,
    lost_reason TEXT,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_contacted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(tenant_id, stage);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(tenant_id, lead_score);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(tenant_id, created_at DESC);

-- Lead activities (timeline)
CREATE TABLE IF NOT EXISTS lead_activities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    activity_type VARCHAR(30), -- call, email, whatsapp, meeting, note, stage_change, score_change, assignment
    title VARCHAR(200),
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lead_activities ON lead_activities(tenant_id, lead_id, created_at DESC);

-- Follow-ups (scheduled tasks)
CREATE TABLE IF NOT EXISTS followups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    title VARCHAR(200),
    description TEXT,
    type VARCHAR(30) DEFAULT 'call', -- call, whatsapp, email, meeting, task
    scheduled_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    completed BOOLEAN DEFAULT false,
    outcome TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_followups_tenant ON followups(tenant_id, completed);
CREATE INDEX IF NOT EXISTS idx_followups_lead ON followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_followups_scheduled ON followups(scheduled_at) WHERE completed = false;

-- ⭐ WhatsApp Messages (shared inbox)
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL, -- inbound, outbound
    message TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text', -- text, image, document, audio, video, template
    media_url TEXT,
    template_name VARCHAR(100),
    wa_message_id VARCHAR(200), -- WhatsApp's message ID
    status VARCHAR(20) DEFAULT 'sent', -- sent, delivered, read, failed
    is_ai_generated BOOLEAN DEFAULT false,
    sent_by UUID REFERENCES users(id) ON DELETE SET NULL,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_tenant ON whatsapp_messages(tenant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_lead ON whatsapp_messages(lead_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_wa_id ON whatsapp_messages(wa_message_id);

-- Notifications (in-app)
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    message TEXT,
    type VARCHAR(30) DEFAULT 'info',
    reference_type VARCHAR(30),
    reference_id UUID,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(tenant_id, user_id, is_read);

-- ============================================
-- Seed data
-- ============================================

INSERT INTO plans (name, price, max_leads, max_users, features) VALUES
('Free', 0, 20, 1, '{"meta_ads": false, "ai_scoring": false, "whatsapp_inbox": false}'),
('Starter', 9, 100, 1, '{"meta_ads": true, "ai_scoring": false, "whatsapp_inbox": true}'),
('Growth', 29, 1000, 5, '{"meta_ads": true, "ai_scoring": true, "whatsapp_inbox": true, "campaigns": true}'),
('Pro', 0, -1, -1, '{"meta_ads": true, "ai_scoring": true, "whatsapp_inbox": true, "campaigns": true, "api_access": true}')
ON CONFLICT (name) DO NOTHING;
