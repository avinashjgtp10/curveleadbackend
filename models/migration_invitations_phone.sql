-- ============================================
-- Add phone to invitations so it carries through to the created user
-- Run in pgAdmin on RDS curvelead database
-- ============================================

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
