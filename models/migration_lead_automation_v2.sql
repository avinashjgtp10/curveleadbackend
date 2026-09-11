-- Lead Automation Rules v2
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_lead_automation_v2.sql

-- Opt-out / compliance
ALTER TABLE leads ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMP;

-- Cancellation audit trail (shared by opt-out, stop-on-reply, lost-stage cancel)
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS cancelled_reason VARCHAR(30);

-- Campaign-specific automation triggers
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_automation_rules_campaign ON automation_rules(tenant_id, campaign_id) WHERE campaign_id IS NOT NULL;

-- Timing / frequency / unresponsive tracking
ALTER TABLE leads ADD COLUMN IF NOT EXISTS automation_unresponsive BOOLEAN NOT NULL DEFAULT false;

-- Escalation
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT false;

-- Templates assignable to stage/campaign; approved-template fallback per sequence step
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS stage_name VARCHAR(50);
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS approved_template_name VARCHAR(200);

-- Reporting: distinguish automated sends from manual ones
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS is_automated BOOLEAN NOT NULL DEFAULT false;
