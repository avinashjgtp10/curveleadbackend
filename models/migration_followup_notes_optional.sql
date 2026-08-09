-- ============================================
-- Make follow-up notes optional - Run in pgAdmin on RDS curvelead database
-- ============================================

-- The app has always treated Schedule Follow-up notes as optional (both
-- the UI label and backend insert already handle a blank value as NULL),
-- but the column itself still had a NOT NULL constraint left over from an
-- earlier design, causing every notes-less follow-up to fail with a 500.
ALTER TABLE lead_followups ALTER COLUMN notes DROP NOT NULL;
