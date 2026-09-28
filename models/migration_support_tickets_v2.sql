-- Extends support_tickets so tenant users can raise/track requests from the
-- in-app Help & Support page, alongside the existing public Contact Us form.
-- Run in pgAdmin / via psql on the curvelead database:
--   psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f models/migration_support_tickets_v2.sql

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS subject VARCHAR(200);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'General';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium';

CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant_user ON support_tickets(tenant_id, created_by, created_at DESC);
