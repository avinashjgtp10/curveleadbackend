-- Support ticket details — subject, category and priority from the in-app Help & Support form.
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_support_ticket_details.sql
-- Safe to run more than once. The API works without it (it falls back to the original columns).

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS subject  VARCHAR(200);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(10);  -- low | medium | high

CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON support_tickets(tenant_id, created_at DESC);
