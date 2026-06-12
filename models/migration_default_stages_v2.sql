-- ============================================
-- Update default lead stages to new 10-stage pipeline
-- Run in pgAdmin on your RDS database
-- Safe: lead.stage is VARCHAR (not FK), so no lead data is lost
-- ============================================

-- Step 1: Remove existing default/system stages for all tenants
-- Custom stages added by users are preserved if they were NOT is_default
DELETE FROM lead_stages WHERE is_active = true;

-- Step 2: Re-insert the new 10 default stages for every existing tenant
INSERT INTO lead_stages (tenant_id, name, pos, position, color, is_won, is_lost, is_active)
SELECT t.id, s.name, s.pos, s.pos, s.color, s.is_won, s.is_lost, true
FROM tenants t
CROSS JOIN (VALUES
  (1,  'New Lead',              'blue',   false, false),
  (2,  'Contacted',             'yellow', false, false),
  (3,  'Qualified',             'purple', false, false),
  (4,  'Interested',            'green',  false, false),
  (5,  'Demo/Visit Scheduled',  'cyan',   false, false),
  (6,  'Proposal Shared',       'orange', false, false),
  (7,  'Negotiation',           'amber',  false, false),
  (8,  'Converted',             'green',  true,  false),
  (9,  'Lost',                  'red',    false, true),
  (10, 'Follow-up Later',       'gray',   false, false)
) AS s(pos, name, color, is_won, is_lost);

-- Verify
SELECT t.name as tenant, ls.pos, ls.name as stage, ls.color
FROM lead_stages ls
JOIN tenants t ON ls.tenant_id = t.id
ORDER BY t.name, ls.pos;
