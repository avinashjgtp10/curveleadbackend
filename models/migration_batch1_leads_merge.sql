-- ============================================
-- Batch 1 (B): phone dedupe + soft lead merges. Transactional and safe to rerun.
-- Apply BEFORE deploying the Batch 1 backend (queries filter on merged_into_id):
--   psql -v ON_ERROR_STOP=1 -f models/migration_batch1_leads_merge.sql
-- Then: node scripts/mergeDuplicateLeads.js (dry run) → review → --apply
-- ============================================
BEGIN;

-- A merged lead stays in the table (no hard deletes); it points at the lead it was merged into.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS merged_at timestamptz;
CREATE INDEX IF NOT EXISTS leads_merged_into ON leads (merged_into_id) WHERE merged_into_id IS NOT NULL;

-- Digits-only phone for format-independent matching (WhatsApp inbound, dedupe).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_digits text
  GENERATED ALWAYS AS (regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')) STORED;
CREATE INDEX IF NOT EXISTS leads_tenant_phone_digits_live ON leads (tenant_id, phone_digits) WHERE merged_into_id IS NULL;

-- One row per merged lead: everything needed to explain or undo the merge.
CREATE TABLE IF NOT EXISTS lead_merges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kept_lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  merged_lead_id   uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kept_before      jsonb NOT NULL,      -- the kept lead's row before the merge
  merged_before    jsonb NOT NULL,      -- the merged lead's row before the merge
  field_changes    jsonb NOT NULL DEFAULT '{}',   -- column → { from, to } applied to the kept lead
  moved            jsonb NOT NULL DEFAULT '{}',   -- table → ids moved to the kept lead
  left_behind      jsonb NOT NULL DEFAULT '{}',   -- table → ids that could not move (unique conflicts)
  reason           text NOT NULL,                 -- 'phone_backfill' | 'manual'
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_merges_tenant ON lead_merges (tenant_id, created_at DESC);

COMMIT;
