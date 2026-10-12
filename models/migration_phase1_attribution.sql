-- Phase 1 / lead attribution: which campaign originally brought each lead, captured ONCE and kept.
-- NOT APPLIED TO ANY DATABASE. Additive: two new tables, functions and triggers on leads (nothing existing changes).
--
--   * original_* never change once set (fill-once only): a later campaign rename, deletion or edit cannot rewrite history.
--   * effective_crm_campaign_id is what reports use. It starts equal to the original and changes only by an audited
--     correction (service) or by a staff edit of leads.campaign_id (recorded as a 'changed' event).
--   * Capture happens in the DATABASE on lead INSERT, so every ingestion path (Meta, Google, WhatsApp, import, manual,
--     API) is covered with no application change. The columns are read through to_jsonb(NEW), so a column that does
--     not exist in a given database simply reads as NULL instead of breaking the insert.
--   * A lead that arrives before its campaign is known (campaign_id NULL) completes its original attribution ONCE,
--     when campaign_id is first set. After that, a change is an edit, not a rewrite of the original.
--   * No error handling inside the triggers: if attribution cannot be recorded, the lead write fails and rolls back.
-- Rollback: DROP TRIGGER lead_attribution_capture / lead_attribution_complete ON leads; tables can stay (see bottom).

CREATE TABLE IF NOT EXISTS lead_attribution (
  lead_id                    uuid PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status                     text NOT NULL CHECK (status IN ('verified', 'inferred', 'manual', 'unattributed')),
  capture_basis              text NOT NULL DEFAULT 'live' CHECK (capture_basis IN ('live', 'backfill')),
  original_source            text,
  original_source_detail    text,
  original_crm_campaign_id   uuid,            -- no foreign key: it must survive the campaign being deleted
  original_meta_lead_id      text,
  original_meta_ad_id        text,
  original_meta_adset_id     text,
  original_meta_form_id      text,
  original_google_lead_id    text,
  original_google_campaign_id text,
  original_google_adgroup_id text,
  original_google_creative_id text,
  original_gclid             text,
  effective_crm_campaign_id  uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  corrected_at               timestamptz,
  corrected_by               uuid,
  correction_reason          text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_attribution_campaign_idx ON lead_attribution (tenant_id, effective_crm_campaign_id);

CREATE TABLE IF NOT EXISTS lead_attribution_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  event      text NOT NULL CHECK (event IN ('captured', 'completed', 'changed', 'corrected', 'merged_in')),
  before     jsonb,
  after      jsonb,
  reason     text,
  actor      uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_attribution_events_lead_idx ON lead_attribution_events (lead_id, created_at);

CREATE OR REPLACE FUNCTION lead_attribution_events_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'lead_attribution_events rows are never changed' USING ERRCODE = 'P0001'; END $$;
DROP TRIGGER IF EXISTS lead_attribution_events_immutable ON lead_attribution_events;
CREATE TRIGGER lead_attribution_events_immutable BEFORE UPDATE ON lead_attribution_events
  FOR EACH ROW EXECUTE FUNCTION lead_attribution_events_no_update();

-- Evidence of a real platform origin, read safely whatever columns exist.
CREATE OR REPLACE FUNCTION lead_has_platform_evidence(j jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(btrim(j ->> 'meta_lead_id'), ''), NULLIF(btrim(j ->> 'meta_ad_id'), ''), NULLIF(btrim(j ->> 'google_lead_id'), ''),
                  NULLIF(btrim(j ->> 'gclid'), ''), NULLIF(btrim(j ->> 'google_campaign_id'), '')) IS NOT NULL
$$;

-- original_* may be filled once (NULL -> value) and never rewritten; the lead and workspace never change.
CREATE OR REPLACE FUNCTION lead_attribution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed text;
BEGIN
  IF NEW.lead_id <> OLD.lead_id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'IMMUTABLE: the lead and workspace of an attribution never change' USING ERRCODE = 'P0001';
  END IF;
  SELECT o.k INTO changed FROM jsonb_each(to_jsonb(OLD)) AS o(k, v)
   WHERE o.k LIKE 'original\_%' AND o.v <> 'null'::jsonb AND to_jsonb(NEW) -> o.k IS DISTINCT FROM o.v LIMIT 1;
  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE: % is the original attribution and never changes; record a correction instead', changed USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lead_attribution_guard_trigger ON lead_attribution;
CREATE TRIGGER lead_attribution_guard_trigger BEFORE UPDATE ON lead_attribution
  FOR EACH ROW EXECUTE FUNCTION lead_attribution_guard();

-- Capture on INSERT.
CREATE OR REPLACE FUNCTION capture_lead_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jsonb := to_jsonb(NEW); st text;
BEGIN
  st := CASE WHEN lead_has_platform_evidence(j) THEN 'verified' WHEN NEW.campaign_id IS NOT NULL THEN 'inferred' ELSE 'unattributed' END;
  INSERT INTO lead_attribution (lead_id, tenant_id, status, capture_basis, original_source, original_source_detail, original_crm_campaign_id,
      original_meta_lead_id, original_meta_ad_id, original_meta_adset_id, original_meta_form_id, original_google_lead_id,
      original_google_campaign_id, original_google_adgroup_id, original_google_creative_id, original_gclid, effective_crm_campaign_id)
  VALUES (NEW.id, NEW.tenant_id, st, 'live', NULLIF(btrim(j ->> 'source'), ''), NULLIF(btrim(j ->> 'source_detail'), ''), NEW.campaign_id,
      NULLIF(btrim(j ->> 'meta_lead_id'), ''), NULLIF(btrim(j ->> 'meta_ad_id'), ''), NULLIF(btrim(j ->> 'meta_adset_id'), ''), NULLIF(btrim(j ->> 'meta_form_id'), ''),
      NULLIF(btrim(j ->> 'google_lead_id'), ''), NULLIF(btrim(j ->> 'google_campaign_id'), ''), NULLIF(btrim(j ->> 'google_adgroup_id'), ''),
      NULLIF(btrim(j ->> 'google_creative_id'), ''), NULLIF(btrim(j ->> 'gclid'), ''), NEW.campaign_id)
  ON CONFLICT (lead_id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO lead_attribution_events (tenant_id, lead_id, event, after) VALUES (NEW.tenant_id, NEW.id, 'captured',
      jsonb_build_object('status', st, 'crm_campaign_id', NEW.campaign_id, 'source', j ->> 'source'));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lead_attribution_capture ON leads;
CREATE TRIGGER lead_attribution_capture AFTER INSERT ON leads FOR EACH ROW EXECUTE FUNCTION capture_lead_attribution();

-- campaign_id changed on an existing lead.
--   NULL -> value on a lead whose original has no campaign: COMPLETES the original (once).
--   anything else: a staff edit. The original is untouched; the effective campaign follows and the change is recorded.
-- The attribution service sets curvelead.attribution_correction so its own audited correction is not logged twice.
CREATE OR REPLACE FUNCTION complete_lead_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; j jsonb := to_jsonb(NEW); evidence boolean;
BEGIN
  IF current_setting('curvelead.attribution_correction', true) = 'on' THEN RETURN NEW; END IF;
  evidence := lead_has_platform_evidence(j);
  SELECT * INTO a FROM lead_attribution WHERE lead_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO lead_attribution (lead_id, tenant_id, status, capture_basis, original_crm_campaign_id, effective_crm_campaign_id)
    VALUES (NEW.id, NEW.tenant_id, CASE WHEN evidence THEN 'verified' WHEN NEW.campaign_id IS NOT NULL THEN 'inferred' ELSE 'unattributed' END, 'live', NEW.campaign_id, NEW.campaign_id);
    INSERT INTO lead_attribution_events (tenant_id, lead_id, event, after) VALUES (NEW.tenant_id, NEW.id, 'captured', jsonb_build_object('crm_campaign_id', NEW.campaign_id));
    RETURN NEW;
  END IF;
  IF OLD.campaign_id IS NULL AND NEW.campaign_id IS NOT NULL AND a.original_crm_campaign_id IS NULL AND a.corrected_at IS NULL THEN
    UPDATE lead_attribution SET original_crm_campaign_id = NEW.campaign_id, effective_crm_campaign_id = NEW.campaign_id,
        status = CASE WHEN evidence THEN 'verified' ELSE 'inferred' END,
        original_meta_lead_id = COALESCE(original_meta_lead_id, NULLIF(btrim(j ->> 'meta_lead_id'), '')),
        original_meta_ad_id = COALESCE(original_meta_ad_id, NULLIF(btrim(j ->> 'meta_ad_id'), '')),
        original_meta_adset_id = COALESCE(original_meta_adset_id, NULLIF(btrim(j ->> 'meta_adset_id'), '')),
        original_meta_form_id = COALESCE(original_meta_form_id, NULLIF(btrim(j ->> 'meta_form_id'), '')),
        original_google_lead_id = COALESCE(original_google_lead_id, NULLIF(btrim(j ->> 'google_lead_id'), '')),
        original_google_campaign_id = COALESCE(original_google_campaign_id, NULLIF(btrim(j ->> 'google_campaign_id'), '')),
        original_google_adgroup_id = COALESCE(original_google_adgroup_id, NULLIF(btrim(j ->> 'google_adgroup_id'), '')),
        original_google_creative_id = COALESCE(original_google_creative_id, NULLIF(btrim(j ->> 'google_creative_id'), '')),
        original_gclid = COALESCE(original_gclid, NULLIF(btrim(j ->> 'gclid'), ''))
     WHERE lead_id = NEW.id;
    INSERT INTO lead_attribution_events (tenant_id, lead_id, event, after) VALUES (NEW.tenant_id, NEW.id, 'completed',
      jsonb_build_object('crm_campaign_id', NEW.campaign_id, 'status', CASE WHEN evidence THEN 'verified' ELSE 'inferred' END));
  ELSIF NEW.campaign_id IS NULL THEN
    NULL; -- the campaign was removed from the lead (or deleted): attribution is sticky, the original and effective values stay
  ELSE
    UPDATE lead_attribution SET effective_crm_campaign_id = NEW.campaign_id, status = 'manual', corrected_at = now(), correction_reason = 'edited on the lead'
     WHERE lead_id = NEW.id;
    INSERT INTO lead_attribution_events (tenant_id, lead_id, event, before, after, reason) VALUES (NEW.tenant_id, NEW.id, 'changed',
      jsonb_build_object('crm_campaign_id', OLD.campaign_id), jsonb_build_object('crm_campaign_id', NEW.campaign_id), 'edited on the lead');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lead_attribution_complete ON leads;
CREATE TRIGGER lead_attribution_complete AFTER UPDATE ON leads FOR EACH ROW
  WHEN (OLD.campaign_id IS DISTINCT FROM NEW.campaign_id) EXECUTE FUNCTION complete_lead_attribution();

-- ROLLBACK
--   DROP TRIGGER IF EXISTS lead_attribution_capture ON leads;
--   DROP TRIGGER IF EXISTS lead_attribution_complete ON leads;
--   (tables, functions and recorded history can stay unused; scripts/backfillAttribution.js recreates missing rows)
