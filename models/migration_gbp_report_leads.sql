-- ============================================
-- GBP report lead-capture migration - Run in pgAdmin on RDS curvelead database
-- Captures business name + WhatsApp number submitted on the public
-- /gbp-report marketing landing page. Not tenant-scoped — these are
-- CurveLead's own top-of-funnel leads, not customer pipeline data.
-- ============================================

CREATE TABLE IF NOT EXISTS gbp_report_leads (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business     VARCHAR(255) NOT NULL,
  phone        VARCHAR(20) NOT NULL,
  country_dial VARCHAR(6) NOT NULL DEFAULT '+91',
  source       VARCHAR(50) NOT NULL DEFAULT 'gbp-report-landing-page',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gbp_report_leads_created ON gbp_report_leads(created_at DESC);
