-- ============================================
-- Stage + Status System Migration
-- Run on RDS after deploying new code
-- ============================================

-- 1. Add lead_status column to leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_status VARCHAR(100);

-- 2. Fix lead_stages: ensure position column exists (legacy alias for pos)
ALTER TABLE lead_stages ADD COLUMN IF NOT EXISTS position INTEGER;
UPDATE lead_stages SET position = pos WHERE position IS NULL;

-- 3. Create lead_statuses table
CREATE TABLE IF NOT EXISTS lead_statuses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  stage_id    UUID REFERENCES lead_stages(id) ON DELETE SET NULL,
  name        VARCHAR(100) NOT NULL,
  color       VARCHAR(20) DEFAULT '#6B7280',
  pos         INTEGER NOT NULL DEFAULT 0,
  is_default  BOOLEAN DEFAULT false,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Create lead_stage_history table
CREATE TABLE IF NOT EXISTS lead_stage_history (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL,
  lead_id      UUID REFERENCES leads(id) ON DELETE CASCADE,
  prev_stage   VARCHAR(100),
  new_stage    VARCHAR(100),
  prev_status  VARCHAR(100),
  new_status   VARCHAR(100),
  changed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notes        TEXT
);

-- 5. Indexes
CREATE INDEX IF NOT EXISTS idx_lead_statuses_tenant ON lead_statuses(tenant_id, pos);
CREATE INDEX IF NOT EXISTS idx_lead_statuses_stage  ON lead_statuses(stage_id);
CREATE INDEX IF NOT EXISTS idx_lead_stage_history_lead   ON lead_stage_history(lead_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_stage_history_tenant ON lead_stage_history(tenant_id, changed_at DESC);

-- 6. Seed default statuses for existing tenants
INSERT INTO lead_statuses (tenant_id, stage_id, name, pos, is_default, is_active)
SELECT
  ls.tenant_id,
  CASE s.stage_name
    WHEN ls.name THEN ls.id
    ELSE NULL
  END as stage_id,
  s.status_name,
  s.pos,
  s.is_default,
  true
FROM (VALUES
  ('New Lead',             'New',                   1,  true),
  ('Contacted',            'Calling',               1,  false),
  ('Contacted',            'No Answer',             2,  false),
  ('Contacted',            'Busy',                  3,  false),
  ('Contacted',            'Switched Off',          4,  false),
  ('Contacted',            'Invalid Number',        5,  false),
  ('Contacted',            'WhatsApp Sent',         6,  false),
  ('Contacted',            'SMS Sent',              7,  false),
  ('Contacted',            'Email Sent',            8,  false),
  ('Contacted',            'Call Back Later',       9,  false),
  ('Contacted',            'Connected',             10, false),
  ('Qualified',            'Interested',            1,  false),
  ('Qualified',            'Not Interested',        2,  false),
  ('Qualified',            'Follow-up Required',    3,  false),
  ('Demo/Visit Scheduled', 'Scheduled',             1,  false),
  ('Demo/Visit Scheduled', 'Rescheduled',           2,  false),
  ('Demo/Visit Scheduled', 'Cancelled',             3,  false),
  ('Proposal Shared',      'Proposal Sent',         1,  false),
  ('Proposal Shared',      'Viewed',                2,  false),
  ('Proposal Shared',      'Awaiting Response',     3,  false),
  ('Negotiation',          'Price Discussion',      1,  false),
  ('Negotiation',          'Feature Discussion',    2,  false),
  ('Negotiation',          'Waiting for Decision',  3,  false),
  ('Converted',            'Customer',              1,  true),
  ('Lost',                 'No Response',           1,  false),
  ('Lost',                 'Price',                 2,  false),
  ('Lost',                 'Competitor',            3,  false),
  ('Lost',                 'Not Interested',        4,  false),
  ('Follow-up Later',      'Waiting for Payment',   1,  false),
  ('Follow-up Later',      'Invoice Sent',          2,  false)
) AS s(stage_name, status_name, pos, is_default)
JOIN lead_stages ls ON ls.tenant_id IS NOT NULL AND LOWER(ls.name) = LOWER(s.stage_name)
WHERE NOT EXISTS (
  SELECT 1 FROM lead_statuses x
  WHERE x.tenant_id = ls.tenant_id AND LOWER(x.name) = LOWER(s.status_name)
);

-- Verify
SELECT t.name as tenant, COUNT(ls.id) as status_count
FROM lead_statuses ls
JOIN tenants t ON ls.tenant_id = t.id
GROUP BY t.name
ORDER BY t.name;
