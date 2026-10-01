BEGIN;
ALTER TABLE assignment_rules ADD COLUMN IF NOT EXISTS staff_ids uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS integration_health (
 tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE, provider text NOT NULL,
 last_lead_received_at timestamptz, token_valid boolean, checked_at timestamptz,
 monitoring_since timestamptz NOT NULL DEFAULT now(), alerted_at timestamptz,
 PRIMARY KEY(tenant_id,provider)
);
CREATE TABLE IF NOT EXISTS outgoing_webhooks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 url text NOT NULL, secret text NOT NULL, events text[] NOT NULL, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 webhook_id uuid NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE, event text NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), response_code int, error text,
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_due ON webhook_deliveries(next_attempt_at) WHERE status='pending';
CREATE TABLE IF NOT EXISTS content_links (
 token text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN ('brochure','quotation')),
 content_id uuid NOT NULL, title text NOT NULL, destination text NOT NULL, first_viewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inbound_reply_claims (
 tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE, message_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,message_id)
);
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS broadcast_id uuid;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS broadcast_sent boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS whatsapp_broadcast_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 template_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), recipients int NOT NULL DEFAULT 0,
 sent int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS whatsapp_quota_claims (
 tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE, phone text NOT NULL,
 claimed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,phone)
);
CREATE TABLE IF NOT EXISTS meta_capi_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
 lead_id uuid REFERENCES leads(id) ON DELETE CASCADE, lead_snapshot jsonb NOT NULL, event_name text NOT NULL,
 status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);
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
    SELECT COALESCE(NULLIF(s.meta_event_name,''),CASE WHEN s.is_won THEN COALESCE(t.settings->>'meta_won_event','ConvertedLead') WHEN lower(NEW.stage)='qualified' THEN COALESCE(t.settings->>'meta_qualified_event','QualifiedLead') END)
      INTO conversion_name FROM tenants t LEFT JOIN lead_stages s ON s.tenant_id=t.id AND lower(s.name)=lower(NEW.stage) WHERE t.id=NEW.tenant_id LIMIT 1;
    IF conversion_name IS NOT NULL THEN INSERT INTO meta_capi_queue(tenant_id,lead_id,lead_snapshot,event_name) VALUES(NEW.tenant_id,NEW.id,to_jsonb(NEW),conversion_name); END IF;
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
DROP TRIGGER IF EXISTS phase4_lead_events_trigger ON leads;
CREATE TRIGGER phase4_lead_events_trigger AFTER INSERT OR UPDATE OF stage ON leads FOR EACH ROW EXECUTE FUNCTION phase4_lead_events();
CREATE OR REPLACE FUNCTION phase4_duplicate_received() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE provider_name text;
BEGIN
 IF NEW.activity_type='duplicate' THEN
 provider_name := CASE NEW.metadata->'submission'->>'source' WHEN 'meta_ads' THEN 'facebook' WHEN 'google_ads' THEN 'google_ads' WHEN 'whatsapp' THEN 'whatsapp' END;
 IF provider_name IS NOT NULL THEN INSERT INTO integration_health(tenant_id,provider,last_lead_received_at,token_valid) VALUES(NEW.tenant_id,provider_name,now(),true) ON CONFLICT(tenant_id,provider) DO UPDATE SET last_lead_received_at=now(),token_valid=true; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS phase4_duplicate_received_trigger ON lead_activities;
CREATE TRIGGER phase4_duplicate_received_trigger AFTER INSERT ON lead_activities FOR EACH ROW EXECUTE FUNCTION phase4_duplicate_received();
COMMIT;
