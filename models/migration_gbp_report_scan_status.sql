-- ============================================
-- GBP report scan-status migration - Run in pgAdmin on RDS curvelead database
-- Adds server-tracked progress for the "scanning" step list shown on the
-- /gbp-report landing page after a lead submits. There's still no real
-- Google Business Profile lookup — the backend just advances scan_step on a
-- timer after insert so the frontend can poll real state instead of running
-- its own throwaway client-side countdown.
-- ============================================

ALTER TABLE gbp_report_leads
  ADD COLUMN IF NOT EXISTS scan_step INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scan_completed BOOLEAN NOT NULL DEFAULT false;
