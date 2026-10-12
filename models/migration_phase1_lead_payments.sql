-- Phase 1 / payment ledger: what customers actually PAID, separate from the quoted deal value.
-- NOT APPLIED TO ANY DATABASE. Additive: new tables, functions, triggers and views, plus one small guard on
-- leads.merged_into_id. Nothing reads these tables until the finance.ledger workspace flag is turned on.
--
-- The rules live HERE, in the database, so no code path (a script, a future endpoint, a manual SQL session)
-- can bypass them:
--   * A row is never deleted.
--   * amount, currency, kind, lead and links never change after insert. A wrong amount is fixed by a reversal
--     plus a new payment, both stay visible.
--   * Only a PENDING entry can change status (once, to completed / failed / cancelled).
--   * Payment details (date, method, reference, notes) of a COUNTED entry change only inside an audited correction,
--     and the old and new values are written to financial_audit_log automatically (pending entries stay editable).
--   * A refund or reversal must reference a completed payment of the SAME lead and currency, and can never take
--     more than what is left of it. Concurrent refunds are serialized by a lock on the payment row.
--   * Money never changes owner: when leads are merged the payments stay on their original lead and reports
--     resolve each lead to its root (v_person_net_collected).
--   * A merged lead accepts no new payments.
-- Rollback: nothing here is ever deleted, so rollback means turning the workspace flag off. The objects can stay.

CREATE TABLE IF NOT EXISTS lead_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  lead_id              uuid NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  kind                 text NOT NULL CHECK (kind IN ('payment', 'refund', 'reversal', 'adjustment')),
  status               text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  amount               numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency             text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  adjustment_direction text CHECK (adjustment_direction IN ('credit', 'debit')),
  parent_id            uuid REFERENCES lead_payments(id) ON DELETE RESTRICT,   -- refund / reversal -> the payment
  replaces_id          uuid REFERENCES lead_payments(id) ON DELETE RESTRICT,   -- a corrected payment -> the one it replaces
  paid_on              date,
  paid_on_basis        text NOT NULL DEFAULT 'confirmed' CHECK (paid_on_basis IN ('confirmed', 'estimated', 'unknown')),
  estimated_paid_on    date,
  method               text,
  reference            text,
  notes                text,
  reason               text,
  idempotency_key      text NOT NULL,
  source               text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'migration')),
  created_by           uuid,                      -- deliberately no foreign key: the trail must survive user changes
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('refund', 'reversal')) = (parent_id IS NOT NULL)),
  CHECK ((kind = 'adjustment') = (adjustment_direction IS NOT NULL)),
  CHECK (kind NOT IN ('refund', 'reversal', 'adjustment') OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CHECK (kind <> 'payment' OR paid_on_basis <> 'confirmed' OR paid_on IS NOT NULL OR status <> 'completed'),   -- only a COMPLETED confirmed payment needs its date
  CHECK (btrim(idempotency_key) <> '')
);

-- Duplicate prevention, in layers (the application adds a soft same-lead/amount/date confirmation on top).
CREATE UNIQUE INDEX IF NOT EXISTS lead_payments_idempotency_uq ON lead_payments (tenant_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS lead_payments_reference_uq ON lead_payments (tenant_id, lower(btrim(method)), lower(btrim(reference)))
  WHERE kind = 'payment' AND status IN ('pending', 'completed') AND method IS NOT NULL AND btrim(method) <> '' AND reference IS NOT NULL AND btrim(reference) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS lead_payments_one_reversal_uq ON lead_payments (parent_id) WHERE kind = 'reversal' AND status IN ('pending', 'completed');
CREATE INDEX IF NOT EXISTS lead_payments_lead_idx ON lead_payments (tenant_id, lead_id, currency);
CREATE INDEX IF NOT EXISTS lead_payments_parent_idx ON lead_payments (parent_id) WHERE parent_id IS NOT NULL;

-- Append-only trail. No foreign key to leads, so it survives anything that happens to the lead.
CREATE TABLE IF NOT EXISTS financial_audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  lead_id    uuid,
  entity     text NOT NULL,
  entity_id  uuid,
  action     text NOT NULL,
  before     jsonb,
  after      jsonb,
  reason     text,
  actor      uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS financial_audit_lead_idx ON financial_audit_log (tenant_id, lead_id, created_at);
CREATE INDEX IF NOT EXISTS financial_audit_entity_idx ON financial_audit_log (entity, entity_id);

CREATE OR REPLACE FUNCTION financial_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'financial_audit_log is append-only' USING ERRCODE = 'P0001'; END $$;
DROP TRIGGER IF EXISTS financial_audit_log_immutable ON financial_audit_log;
CREATE TRIGGER financial_audit_log_immutable BEFORE UPDATE OR DELETE ON financial_audit_log
  FOR EACH ROW EXECUTE FUNCTION financial_audit_log_append_only();

CREATE OR REPLACE FUNCTION lead_payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lead_row record;
  parent_row record;
  used numeric;
  remaining numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lead_payments rows are never deleted; record a reversal instead' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A share lock on the lead: a merge (which locks the lead exclusively) and a payment serialize.
    SELECT tenant_id, merged_into_id INTO lead_row FROM leads WHERE id = NEW.lead_id FOR SHARE;
    IF NOT FOUND OR lead_row.tenant_id <> NEW.tenant_id THEN
      RAISE EXCEPTION 'LEAD_NOT_FOUND: no such lead in this workspace' USING ERRCODE = 'P0001';
    END IF;
    IF lead_row.merged_into_id IS NOT NULL THEN
      RAISE EXCEPTION 'LEAD_MERGED: this lead was merged into another lead; record the payment on the surviving lead' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.kind IN ('refund', 'reversal') THEN
      -- Lock the payment row: concurrent refunds / reversals of one payment run one at a time.
      SELECT * INTO parent_row FROM lead_payments WHERE id = NEW.parent_id FOR UPDATE;
      IF NOT FOUND OR parent_row.tenant_id <> NEW.tenant_id OR parent_row.lead_id <> NEW.lead_id THEN
        RAISE EXCEPTION 'PARENT_NOT_FOUND: no such payment on this lead' USING ERRCODE = 'P0001';
      END IF;
      IF parent_row.kind <> 'payment' OR parent_row.status <> 'completed' THEN
        RAISE EXCEPTION 'PARENT_NOT_COMPLETED: only a completed payment can be refunded or reversed' USING ERRCODE = 'P0001';
      END IF;
      IF parent_row.currency <> NEW.currency THEN
        RAISE EXCEPTION 'CURRENCY_MISMATCH: a refund or reversal must use the payment''s currency (%)', parent_row.currency USING ERRCODE = 'P0001';
      END IF;
      SELECT COALESCE(SUM(amount), 0) INTO used FROM lead_payments
       WHERE parent_id = NEW.parent_id AND kind IN ('refund', 'reversal') AND status IN ('pending', 'completed');
      remaining := parent_row.amount - used;
      IF NEW.amount > remaining THEN
        RAISE EXCEPTION 'OVER_REFUND: the amount exceeds what is left of the payment (%)', remaining USING ERRCODE = 'P0001';
      END IF;
      IF NEW.kind = 'reversal' AND NEW.amount <> remaining THEN
        RAISE EXCEPTION 'REVERSAL_AMOUNT: a reversal must cover the full remaining amount (%)', remaining USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.lead_id <> OLD.lead_id OR NEW.kind <> OLD.kind
     OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.replaces_id IS DISTINCT FROM OLD.replaces_id OR NEW.adjustment_direction IS DISTINCT FROM OLD.adjustment_direction
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.source <> OLD.source OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'IMMUTABLE: the amount, currency, kind, lead and links of a payment never change; reverse it and record a new one' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'STATUS_FINAL: only a pending entry can change status' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.paid_on IS DISTINCT FROM OLD.paid_on OR NEW.paid_on_basis <> OLD.paid_on_basis OR NEW.estimated_paid_on IS DISTINCT FROM OLD.estimated_paid_on
      OR NEW.method IS DISTINCT FROM OLD.method OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.notes IS DISTINCT FROM OLD.notes)
     AND OLD.status <> 'pending'   -- a pending entry is not counted yet, so completing it may set its date; still audited
     AND current_setting('curvelead.payment_edit', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'AUDITED_ONLY: payment details change only through an audited correction' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lead_payments_guard_trigger ON lead_payments;
CREATE TRIGGER lead_payments_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON lead_payments
  FOR EACH ROW EXECUTE FUNCTION lead_payments_guard();

-- Every change is written to the audit log by the database itself (before and after values), whoever made it.
CREATE OR REPLACE FUNCTION lead_payments_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  who uuid := NULLIF(current_setting('curvelead.actor', true), '')::uuid;
  why text := NULLIF(current_setting('curvelead.reason', true), '');
  before_diff jsonb;
  after_diff jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO financial_audit_log (tenant_id, lead_id, entity, entity_id, action, after, reason, actor)
    VALUES (NEW.tenant_id, NEW.lead_id, 'payment', NEW.id, 'created', to_jsonb(NEW), COALESCE(NEW.reason, why), COALESCE(who, NEW.created_by));
    RETURN NEW;
  END IF;
  SELECT jsonb_object_agg(o.k, o.v) INTO before_diff FROM jsonb_each(to_jsonb(OLD)) AS o(k, v)
   WHERE o.k <> 'updated_at' AND to_jsonb(NEW) -> o.k IS DISTINCT FROM o.v;
  IF before_diff IS NULL THEN RETURN NEW; END IF;
  SELECT jsonb_object_agg(n.k, n.v) INTO after_diff FROM jsonb_each(to_jsonb(NEW)) AS n(k, v)
   WHERE n.k <> 'updated_at' AND to_jsonb(OLD) -> n.k IS DISTINCT FROM n.v;
  INSERT INTO financial_audit_log (tenant_id, lead_id, entity, entity_id, action, before, after, reason, actor)
  VALUES (NEW.tenant_id, NEW.lead_id, 'payment', NEW.id,
          CASE WHEN NEW.status <> OLD.status THEN 'status_' || NEW.status ELSE 'details_corrected' END,
          before_diff, after_diff, why, who);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lead_payments_audit_trigger ON lead_payments;
CREATE TRIGGER lead_payments_audit_trigger AFTER INSERT OR UPDATE ON lead_payments
  FOR EACH ROW EXECUTE FUNCTION lead_payments_audit();

-- Merged leads always point at a ROOT lead: a merge target can never itself be merged, and merging a lead that
-- others point at re-points them, so "resolve to the root" is always one step.
CREATE OR REPLACE FUNCTION leads_root_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    IF NEW.merged_into_id = NEW.id THEN
      RAISE EXCEPTION 'a lead cannot be merged into itself' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM leads WHERE id = NEW.merged_into_id AND merged_into_id IS NOT NULL) THEN
      RAISE EXCEPTION 'the merge target is itself merged; merge into its surviving lead' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION leads_root_chain_flatten() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merged_into_id IS NOT NULL AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    UPDATE leads SET merged_into_id = NEW.merged_into_id WHERE merged_into_id = NEW.id AND id <> NEW.merged_into_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS leads_root_chain_guard_trigger ON leads;
CREATE TRIGGER leads_root_chain_guard_trigger BEFORE UPDATE OF merged_into_id ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_root_chain_guard();
DROP TRIGGER IF EXISTS leads_root_chain_flatten_trigger ON leads;
CREATE TRIGGER leads_root_chain_flatten_trigger AFTER UPDATE OF merged_into_id ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_root_chain_flatten();

-- Net collected per lead and currency. Only COMPLETED entries count; pending is reported on its own.
--   payment +, refund -, reversal -, adjustment +/- by direction.
CREATE OR REPLACE VIEW v_lead_net_collected AS
SELECT p.tenant_id, p.lead_id, p.currency,
       COALESCE(SUM(CASE p.kind WHEN 'payment' THEN p.amount WHEN 'refund' THEN -p.amount WHEN 'reversal' THEN -p.amount
                                ELSE CASE p.adjustment_direction WHEN 'credit' THEN p.amount ELSE -p.amount END END)
                FILTER (WHERE p.status = 'completed'), 0) AS net,
       COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'completed' AND p.kind = 'payment'), 0) AS gross_paid,
       COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'pending' AND p.kind = 'payment'), 0) AS pending,
       count(*) FILTER (WHERE p.status = 'completed' AND p.kind = 'payment')::int AS payments
FROM lead_payments p GROUP BY p.tenant_id, p.lead_id, p.currency;

-- The same per PERSON: a merged lead's money counts at its root.
CREATE OR REPLACE VIEW v_person_net_collected AS
SELECT v.tenant_id, COALESCE(l.merged_into_id, l.id) AS root_lead_id, v.currency,
       SUM(v.net) AS net, SUM(v.gross_paid) AS gross_paid, SUM(v.pending) AS pending, SUM(v.payments)::int AS payments
FROM v_lead_net_collected v JOIN leads l ON l.id = v.lead_id AND l.tenant_id = v.tenant_id
GROUP BY v.tenant_id, COALESCE(l.merged_into_id, l.id), v.currency;
