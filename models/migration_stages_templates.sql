-- ============================================
-- Lead Stages + Message Templates Migration
-- Run in pgAdmin on your RDS database
-- ============================================

-- Lead Stages table
CREATE TABLE IF NOT EXISTS lead_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(50) DEFAULT 'blue',
    position INTEGER DEFAULT 0,
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_stages_tenant ON lead_stages(tenant_id, is_active);

-- If the table already existed without these columns, add them safely
ALTER TABLE lead_stages ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE lead_stages ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;
ALTER TABLE lead_stages ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;
ALTER TABLE lead_stages ADD COLUMN IF NOT EXISTS color VARCHAR(50) DEFAULT 'blue';

-- Update any NULLs that exist due to missing defaults
UPDATE lead_stages SET is_active = TRUE WHERE is_active IS NULL;
UPDATE lead_stages SET is_default = FALSE WHERE is_default IS NULL;
UPDATE lead_stages SET color = 'blue' WHERE color IS NULL;

-- Seed default stages for every tenant that has no stages yet
INSERT INTO lead_stages (tenant_id, name, color, position, is_default)
SELECT t.id, s.name, s.color, s.pos, TRUE
FROM tenants t
CROSS JOIN (VALUES
  ('New',         'blue',   1),
  ('Contacted',   'yellow', 2),
  ('Interested',  'green',  3),
  ('Negotiation', 'orange', 4),
  ('Won',         'green',  5),
  ('Lost',        'red',    6)
) AS s(name, color, pos)
WHERE NOT EXISTS (
    SELECT 1 FROM lead_stages ls WHERE ls.tenant_id = t.id
);

-- ============================================

-- Message Templates table
CREATE TABLE IF NOT EXISTS message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    category VARCHAR(50) DEFAULT 'general',
    channel VARCHAR(20) DEFAULT 'whatsapp',
    message TEXT NOT NULL,
    use_count INTEGER DEFAULT 0,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_templates_tenant ON message_templates(tenant_id, category);
