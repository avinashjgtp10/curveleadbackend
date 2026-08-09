-- ============================================
-- Per-user WhatsApp numbers migration - Run in pgAdmin on RDS curvelead database
-- ============================================
-- Lets each team member connect their own WhatsApp Business number instead of
-- everyone sharing the one tenant-level number in tenants.settings.

ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_whatsapp_number ON users(whatsapp_phone_number_id) WHERE whatsapp_phone_number_id IS NOT NULL;
