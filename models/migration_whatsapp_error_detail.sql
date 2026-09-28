-- Captures the actual reason a WhatsApp delivery failed (e.g. "Recipient phone
-- number not a valid WhatsApp user"), so a failed send is diagnosable from the
-- database instead of only showing status='failed' with no explanation.
-- Already applied directly to the production database on 2026-09-28.

ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS error_detail TEXT;
