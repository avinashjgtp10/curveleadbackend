-- Phase 1 / milestone events: ONE durable, idempotent record of when a lead first became qualified and
-- first became a customer (won). Cohort reports read this instead of re-deriving it from stage names.
-- NOT APPLIED TO ANY DATABASE. Additive: a new table, a new function and a new trigger on leads.
-- Rollback (instant, loses nothing the source data cannot recreate): see the bottom of this file.
--
-- Rules the trigger enforces
--   * A milestone is created only when the stage REALLY changes (case/space-insensitive), so an edit form that
--     resends the same stage creates nothing, and a case-only rename creates nothing.
--   * At most ONE live 'qualified' and ONE live 'won' event per lead (partial unique index), so Won -> Converted
--     -> Lost -> Won is one customer. A won stage also implies qualified, like the metrics layer.
--   * A lead CREATED directly in a qualified/won stage (import, API) gets a SUPPRESSED event: kept for audit,
--     never counted as an acquisition at creation.
--   * No error handling inside: if recording fails, the whole stage change fails and rolls back. A milestone
--     that cannot be written is never silently lost. (This replaces the earlier "swallow errors" design.)
--   * Merges set curvelead.skip_milestones = 'on' for their transaction, so moving a stage onto the surviving
--     lead creates no new event.

CREATE TABLE IF NOT EXISTS lead_milestone_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id           uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  milestone         text NOT NULL CHECK (milestone IN ('qualified', 'won')),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  stage_name        text,
  source            text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'backfill')),
  suppressed        boolean NOT NULL DEFAULT false,
  suppressed_reason text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Exactly one counted event per lead and milestone.
CREATE UNIQUE INDEX IF NOT EXISTS lead_milestone_live_uq ON lead_milestone_events (lead_id, milestone) WHERE NOT suppressed;
-- Suppressed events are deduplicated per stage so repeated imports cannot pile up audit rows.
CREATE UNIQUE INDEX IF NOT EXISTS lead_milestone_suppressed_uq ON lead_milestone_events (lead_id, milestone, lower(COALESCE(stage_name, ''))) WHERE suppressed;
CREATE INDEX IF NOT EXISTS lead_milestone_tenant_time ON lead_milestone_events (tenant_id, milestone, occurred_at) WHERE NOT suppressed;

CREATE OR REPLACE FUNCTION record_lead_milestones() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  flags record;
  is_suppressed boolean;
  why text;
BEGIN
  IF current_setting('curvelead.skip_milestones', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND lower(trim(COALESCE(NEW.stage, ''))) = lower(trim(COALESCE(OLD.stage, ''))) THEN RETURN NEW; END IF;

  SELECT COALESCE(s.is_won, false) AS is_won, COALESCE(s.is_qualified, false) AS is_qualified INTO flags
  FROM lead_stages s
  WHERE s.tenant_id = NEW.tenant_id AND lower(trim(s.name)) = lower(trim(NEW.stage))
  ORDER BY COALESCE(s.is_active, true) DESC, s.name LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  is_suppressed := (TG_OP = 'INSERT');
  why := CASE WHEN TG_OP = 'INSERT' THEN 'created_in_stage' END;

  IF flags.is_won OR flags.is_qualified THEN
    INSERT INTO lead_milestone_events (tenant_id, lead_id, milestone, stage_name, suppressed, suppressed_reason)
    VALUES (NEW.tenant_id, NEW.id, 'qualified', NEW.stage, is_suppressed, why) ON CONFLICT DO NOTHING;
  END IF;
  IF flags.is_won THEN
    INSERT INTO lead_milestone_events (tenant_id, lead_id, milestone, stage_name, suppressed, suppressed_reason)
    VALUES (NEW.tenant_id, NEW.id, 'won', NEW.stage, is_suppressed, why) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lead_milestones_trigger ON leads;
CREATE TRIGGER lead_milestones_trigger AFTER INSERT OR UPDATE OF stage ON leads
  FOR EACH ROW EXECUTE FUNCTION record_lead_milestones();

-- ROLLBACK
--   DROP TRIGGER IF EXISTS lead_milestones_trigger ON leads;
--   DROP FUNCTION IF EXISTS record_lead_milestones();
--   DROP TABLE IF EXISTS lead_milestone_events;   -- derived data: scripts/backfillMilestones.js recreates it
