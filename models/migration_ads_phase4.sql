-- ============================================
-- Ads module Phase 4: Conversions API feedback hardening. Transactional, safe to rerun.
-- Apply: psql -v ON_ERROR_STOP=1 -f models/migration_ads_phase4.sql
-- ============================================
BEGIN;

ALTER TABLE meta_capi_queue ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE meta_capi_queue ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE meta_capi_events ADD COLUMN IF NOT EXISTS event_id text;

-- One successful event per lead and event name (no duplicates on production, checked 2026-10-03).
CREATE UNIQUE INDEX IF NOT EXISTS meta_capi_events_one_success
  ON meta_capi_events (tenant_id, lead_id, event_name) WHERE status = 'success';
CREATE INDEX IF NOT EXISTS meta_capi_queue_lead_event ON meta_capi_queue (tenant_id, lead_id, event_name);

-- Same as migration_phase4_features.sql except the Conversions API block:
--  * a stage's own meta_event_name still wins; otherwise a won stage queues ConvertedLead and a
--    stage flagged lead_stages.is_qualified (or named Qualified) queues QualifiedLead — a won,
--    qualified stage queues both;
--  * each (lead, event) is queued once — not again if it is pending or already sent.
CREATE OR REPLACE FUNCTION phase4_lead_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_name text; provider_name text; conversion_name text;
BEGIN
 IF TG_OP='INSERT' THEN
  event_name := 'lead.created';
  provider_name := CASE NEW.source WHEN 'meta_ads' THEN 'facebook' WHEN 'google_ads' THEN 'google_ads' WHEN 'whatsapp' THEN 'whatsapp' END;
  IF provider_name IS NOT NULL THEN
   INSERT INTO integration_health(tenant_id,provider,last_lead_received_at,token_valid) VALUES(NEW.tenant_id,provider_name,now(),true)
    ON CONFLICT(tenant_id,provider) DO UPDATE SET last_lead_received_at=now(),token_valid=true;
  END IF;
 ELSIF lower(COALESCE(NEW.stage,'')) IS DISTINCT FROM lower(COALESCE(OLD.stage,'')) THEN
  event_name := 'lead.stage_changed';
  IF NEW.meta_lead_id IS NOT NULL AND (SELECT COALESCE((settings->>'meta_capi_enabled')::boolean,false) FROM tenants WHERE id=NEW.tenant_id) THEN
    FOR conversion_name IN
      SELECT DISTINCT e FROM (
        SELECT NULLIF(s.meta_event_name,'') AS e
          FROM lead_stages s WHERE s.tenant_id=NEW.tenant_id AND lower(s.name)=lower(NEW.stage)
        UNION ALL
        SELECT COALESCE(t.settings->>'meta_won_event','ConvertedLead')
          FROM tenants t JOIN lead_stages s ON s.tenant_id=t.id AND lower(s.name)=lower(NEW.stage)
          WHERE t.id=NEW.tenant_id AND s.is_won AND NULLIF(s.meta_event_name,'') IS NULL
        UNION ALL
        SELECT COALESCE(t.settings->>'meta_qualified_event','QualifiedLead')
          FROM tenants t LEFT JOIN lead_stages s ON s.tenant_id=t.id AND lower(s.name)=lower(NEW.stage)
          WHERE t.id=NEW.tenant_id AND NULLIF(s.meta_event_name,'') IS NULL
            AND (COALESCE(s.is_qualified,false) OR lower(NEW.stage)='qualified')
      ) x WHERE e IS NOT NULL
    LOOP
      INSERT INTO meta_capi_queue(tenant_id,lead_id,lead_snapshot,event_name)
      SELECT NEW.tenant_id,NEW.id,to_jsonb(NEW),conversion_name
      WHERE NOT EXISTS (SELECT 1 FROM meta_capi_queue q WHERE q.tenant_id=NEW.tenant_id AND q.lead_id=NEW.id
                          AND q.event_name=conversion_name AND q.status IN ('pending','success'));
    END LOOP;
  END IF;
 ELSE RETURN NEW;
 END IF;
 INSERT INTO webhook_deliveries(tenant_id,webhook_id,event,payload)
 SELECT NEW.tenant_id,w.id,event_name,jsonb_build_object('event',event_name,'occurred_at',now(),'lead',jsonb_build_object('id',NEW.id,'name',NEW.name,'phone',NEW.phone,'email',NEW.email,'stage',NEW.stage,'source',NEW.source))
 FROM outgoing_webhooks w WHERE w.tenant_id=NEW.tenant_id AND w.active AND event_name=ANY(w.events);
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM lead_stages WHERE tenant_id=NEW.tenant_id AND lower(name)=lower(NEW.stage) AND is_won=true) THEN
 INSERT INTO webhook_deliveries(tenant_id,webhook_id,event,payload)
 SELECT NEW.tenant_id,w.id,'lead.won',jsonb_build_object('event','lead.won','occurred_at',now(),'lead',jsonb_build_object('id',NEW.id,'name',NEW.name,'phone',NEW.phone,'stage',NEW.stage))
 FROM outgoing_webhooks w WHERE w.tenant_id=NEW.tenant_id AND w.active AND 'lead.won'=ANY(w.events);
 END IF;
 RETURN NEW;
END $$;

COMMIT;
