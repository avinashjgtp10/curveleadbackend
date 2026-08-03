-- ============================================
-- WhatsApp Auto-Responder Migration - Run in pgAdmin on RDS curvelead database
-- ============================================

-- Tracks whether a human has taken over a lead's WhatsApp conversation,
-- so the AI auto-reply stops responding until re-enabled.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN DEFAULT false;
