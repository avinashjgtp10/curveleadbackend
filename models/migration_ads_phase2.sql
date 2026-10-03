-- ============================================
-- Ads module Phase 2: Lead Ads sync. Transactional and safe to rerun.
-- Apply: psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase2.sql
-- ============================================
BEGIN;

-- Which Meta lead form a lead came from.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_form_id varchar(50);

-- One CRM lead per Meta lead. Ingestion already de-duplicates under a lock; this is the
-- database-level guarantee. Pre-checked on production 2026-10-03: no duplicate pairs.
CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_meta_lead_unique
  ON leads (tenant_id, meta_lead_id) WHERE meta_lead_id IS NOT NULL;

-- Lead forms on each workspace's connected Facebook Page, with backfill state.
CREATE TABLE IF NOT EXISTS ad_lead_forms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  page_id              text NOT NULL,
  external_id          text NOT NULL,           -- Meta form id
  name                 text,
  status               text,                    -- ACTIVE / ARCHIVED / …
  leads_count          int,
  created_time         timestamptz,
  last_backfilled_at   timestamptz,
  last_backfill_count  int,
  last_backfill_error  text,
  synced_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);

COMMIT;
