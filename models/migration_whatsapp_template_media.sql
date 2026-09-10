-- ============================================
-- WhatsApp Broadcast Template Media
-- Run in pgAdmin on your RDS database
-- Meta never returns a template's media back to us when listing templates,
-- so we remember which uploaded file belongs to which template ourselves.
-- ============================================

CREATE TABLE IF NOT EXISTS whatsapp_template_media (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_name VARCHAR(255) NOT NULL,
    language VARCHAR(20) NOT NULL,
    media_type VARCHAR(20) NOT NULL,   -- IMAGE | VIDEO | DOCUMENT
    media_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tenant_id, template_name, language)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_template_media_tenant ON whatsapp_template_media(tenant_id);
