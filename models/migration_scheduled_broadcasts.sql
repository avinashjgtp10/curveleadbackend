-- Scheduled WhatsApp broadcasts: a broadcast saved now and sent by the
-- background job (jobs/scheduledBroadcasts.js) at scheduled_at.
-- status: pending -> sending -> sent | failed, or cancelled.
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_scheduled_broadcasts.sql

CREATE TABLE IF NOT EXISTS whatsapp_scheduled_broadcasts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    template_name VARCHAR(100) NOT NULL,
    language_code VARCHAR(20) NOT NULL DEFAULT 'en_US',
    body_text TEXT,
    variable_mapping JSONB NOT NULL DEFAULT '[]',
    lead_ids UUID[] NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_due ON whatsapp_scheduled_broadcasts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_tenant ON whatsapp_scheduled_broadcasts(tenant_id, scheduled_at DESC);
