-- Phase 1 / booked value: what the customer agreed to pay, frozen at the FIRST Won, separate from the editable quote.
-- NOT APPLIED TO ANY DATABASE. Adds five nullable columns to leads (no rewrite), one append-only adjustments table,
-- two triggers and one view. Requires migration_phase1_milestones.sql.
--
--   * leads.deal_value stays the editable CURRENT QUOTE. booked_value is copied from it when the lead first reaches a
--     counted Won (the milestone event), so editing the quote afterwards never changes booked revenue.
--   * If the lead is marked Won before a price exists, the snapshot is taken the first time a price is entered
--     (basis live_snapshot_late), until a booking exists.
--   * A correction is an audited booking_adjustments row (reason required, append-only). The effective booked value
--     is the latest adjustment, else the snapshot (v_lead_booked).
--   * No error handling inside the triggers; a failure rolls back the lead write.
-- Rollback: DROP TRIGGER booked_snapshot_on_won ON lead_milestone_events; DROP TRIGGER booked_snapshot_late ON leads;
--           the columns and adjustments table can stay unused.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS booked_value    numeric(14, 2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS booked_currency text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS booked_at       timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS booked_basis    text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS booked_source   text;

CREATE TABLE IF NOT EXISTS booking_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  previous_value numeric(14, 2),
  new_value      numeric(14, 2) NOT NULL CHECK (new_value >= 0),
  new_currency   text CHECK (new_currency ~ '^[A-Z]{3}$'),
  reason         text NOT NULL CHECK (btrim(reason) <> ''),
  evidence_ref   text,
  actor          uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_adjustments_lead_idx ON booking_adjustments (lead_id, created_at);

CREATE OR REPLACE FUNCTION booking_adjustments_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'booking_adjustments are append-only' USING ERRCODE = 'P0001'; END $$;
DROP TRIGGER IF EXISTS booking_adjustments_immutable ON booking_adjustments;
CREATE TRIGGER booking_adjustments_immutable BEFORE UPDATE OR DELETE ON booking_adjustments
  FOR EACH ROW EXECUTE FUNCTION booking_adjustments_append_only();

-- The workspace's currency, as the app reads it (tenants.settings.currency, default INR).
CREATE OR REPLACE FUNCTION workspace_currency(t uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT CASE WHEN settings ->> 'currency' ~ '^[A-Z]{3}$' THEN settings ->> 'currency' END FROM tenants WHERE id = t), 'INR')
$$;

-- Snapshot when the first counted Won event is recorded.
CREATE OR REPLACE FUNCTION snapshot_booking_on_won() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE leads SET booked_value = deal_value, booked_currency = workspace_currency(NEW.tenant_id), booked_at = NEW.occurred_at,
         booked_basis = CASE WHEN NEW.source = 'backfill' THEN 'inferred_from_deal_value' ELSE 'live_snapshot' END, booked_source = 'won_event'
   WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id AND booked_at IS NULL AND COALESCE(deal_value, 0) > 0;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS booked_snapshot_on_won ON lead_milestone_events;
CREATE TRIGGER booked_snapshot_on_won AFTER INSERT ON lead_milestone_events
  FOR EACH ROW WHEN (NEW.milestone = 'won' AND NOT NEW.suppressed) EXECUTE FUNCTION snapshot_booking_on_won();

-- Won before a price existed: snapshot the first time a price is entered.
CREATE OR REPLACE FUNCTION snapshot_booking_late() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM lead_milestone_events e WHERE e.lead_id = NEW.id AND e.milestone = 'won' AND NOT e.suppressed) THEN
    UPDATE leads SET booked_value = NEW.deal_value, booked_currency = workspace_currency(NEW.tenant_id), booked_at = now(),
           booked_basis = 'live_snapshot_late', booked_source = 'price_entered_after_won'
     WHERE id = NEW.id AND booked_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS booked_snapshot_late ON leads;
CREATE TRIGGER booked_snapshot_late AFTER UPDATE OF deal_value ON leads
  FOR EACH ROW WHEN (NEW.booked_at IS NULL AND COALESCE(NEW.deal_value, 0) > 0 AND NEW.deal_value IS DISTINCT FROM OLD.deal_value)
  EXECUTE FUNCTION snapshot_booking_late();

-- Effective booked value: the latest audited adjustment, else the snapshot.
CREATE OR REPLACE VIEW v_lead_booked AS
SELECT l.id AS lead_id, l.tenant_id, COALESCE(adj.new_value, l.booked_value) AS value, COALESCE(adj.new_currency, l.booked_currency) AS currency,
       l.booked_basis, (adj.id IS NOT NULL) AS adjusted
FROM leads l
LEFT JOIN LATERAL (SELECT b.id, b.new_value, b.new_currency FROM booking_adjustments b WHERE b.lead_id = l.id ORDER BY b.created_at DESC, b.id DESC LIMIT 1) adj ON true
WHERE l.booked_at IS NOT NULL OR adj.id IS NOT NULL;
