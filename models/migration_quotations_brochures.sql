-- ============================================
-- Quotations & Brochures Migration
-- Run in pgAdmin on your RDS database
-- ============================================

-- Quotations
CREATE TABLE IF NOT EXISTS quotations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    quote_number VARCHAR(50),
    title VARCHAR(255),
    lead_name VARCHAR(255),
    lead_phone VARCHAR(20),
    lead_email VARCHAR(255),
    business_name VARCHAR(255),
    business_phone VARCHAR(20),
    business_address TEXT,
    items JSONB DEFAULT '[]',
    subtotal DECIMAL(12,2) DEFAULT 0,
    discount_percent DECIMAL(5,2) DEFAULT 0,
    discount_amount DECIMAL(12,2) DEFAULT 0,
    tax_percent DECIMAL(5,2) DEFAULT 18,
    tax_amount DECIMAL(12,2) DEFAULT 0,
    total DECIMAL(12,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'draft',
    valid_until DATE,
    terms TEXT,
    notes TEXT,
    rejection_reason TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotations_tenant ON quotations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_quotations_lead ON quotations(lead_id);

-- Brochures
CREATE TABLE IF NOT EXISTS brochures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100) DEFAULT 'general',
    file_url VARCHAR(500),
    file_name VARCHAR(255),
    file_size INTEGER,
    mime_type VARCHAR(100),
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brochures_tenant ON brochures(tenant_id);

-- Brochure share log
CREATE TABLE IF NOT EXISTS brochure_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    brochure_id UUID REFERENCES brochures(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    shared_by UUID REFERENCES users(id),
    shared_at TIMESTAMP DEFAULT NOW()
);
