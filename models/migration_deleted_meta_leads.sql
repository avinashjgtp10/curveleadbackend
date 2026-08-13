-- ============================================
-- Deleted Meta leads tombstone - Run in pgAdmin on RDS curvelead database
-- ============================================
-- Deleting a lead is a hard DELETE, which wipes its meta_lead_id along with
-- it. Without a record of "this Meta lead was intentionally removed", the
-- next Facebook sync (or a webhook redelivery) has no way to know it wasn't
-- new, and re-imports it. This table remembers deleted meta_lead_ids per
-- tenant so sync/webhook can skip them for good.

CREATE TABLE IF NOT EXISTS deleted_meta_leads (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meta_lead_id  VARCHAR(100) NOT NULL,
  deleted_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, meta_lead_id)
);
