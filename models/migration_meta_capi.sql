-- ============================================
-- Meta Conversions API Migration - Run in pgAdmin on RDS curvelead database
-- ============================================

-- Per-stage mapping to a Meta standard conversion event name (e.g. Schedule, Purchase)
ALTER TABLE lead_stages ADD COLUMN IF NOT EXISTS meta_event_name VARCHAR(50);

-- Audit log of events sent to Meta's Conversions API
CREATE TABLE IF NOT EXISTS meta_capi_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    event_name VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL, -- 'success' | 'error'
    response_body TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
