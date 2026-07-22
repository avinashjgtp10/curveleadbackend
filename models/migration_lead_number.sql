-- Human-friendly, searchable Lead ID (e.g. LD-00001), per tenant.
-- Run in pgAdmin on your RDS database

ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_number VARCHAR(20);

CREATE TABLE IF NOT EXISTS lead_counter (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    last_number INTEGER NOT NULL DEFAULT 0,
    prefix VARCHAR(10) NOT NULL DEFAULT 'LD'
);

-- Backfill existing leads in creation order, per tenant
WITH numbered AS (
  SELECT id, tenant_id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at) AS rn
  FROM leads
  WHERE lead_number IS NULL
)
UPDATE leads l
SET lead_number = 'LD-' || LPAD(numbered.rn::text, 5, '0')
FROM numbered
WHERE l.id = numbered.id;

INSERT INTO lead_counter (tenant_id, last_number, prefix)
SELECT tenant_id, COUNT(*), 'LD' FROM leads GROUP BY tenant_id
ON CONFLICT (tenant_id) DO UPDATE SET last_number = GREATEST(lead_counter.last_number, EXCLUDED.last_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_tenant_lead_number ON leads(tenant_id, lead_number);
