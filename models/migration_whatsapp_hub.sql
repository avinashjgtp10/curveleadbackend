-- WhatsApp hub: explicit opt-in tracking.
-- A lead counts as opted in when whatsapp_opt_in_at is set (and opted_out is false).
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_whatsapp_hub.sql

ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp_opt_in_source VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_leads_wa_opt_in ON leads(tenant_id, whatsapp_opt_in_at) WHERE whatsapp_opt_in_at IS NOT NULL;
