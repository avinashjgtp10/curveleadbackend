BEGIN;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS lead_submissions (
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 submission_key text NOT NULL,
 lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, submission_key)
);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_budget numeric(12,2);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS lifetime_budget numeric(12,2);
-- NOT VALID permits historical rows until the dry-run backfill is reviewed.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='leads_source_canonical') THEN
 ALTER TABLE leads ADD CONSTRAINT leads_source_canonical CHECK (source IN ('manual','meta_ads','google_ads','whatsapp','website','api','import','referral','organic','instagram','walkin','other')) NOT VALID;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION record_lead_transition() RETURNS trigger AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF lower(trim(NEW.stage))='won' THEN
     INSERT INTO lead_stage_history (tenant_id,lead_id,new_stage,changed_at) VALUES (NEW.tenant_id,NEW.id,NEW.stage,COALESCE(NEW.won_at,NEW.created_at));
   END IF;
 ELSIF NEW.stage IS DISTINCT FROM OLD.stage OR NEW.lead_status IS DISTINCT FROM OLD.lead_status THEN
   INSERT INTO lead_stage_history (tenant_id,lead_id,prev_stage,new_stage,prev_status,new_status)
   VALUES (NEW.tenant_id,NEW.id,OLD.stage,NEW.stage,OLD.lead_status,NEW.lead_status);
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS lead_transition_history ON leads;
CREATE TRIGGER lead_transition_history AFTER INSERT OR UPDATE OF stage,lead_status ON leads FOR EACH ROW EXECUTE FUNCTION record_lead_transition();
CREATE INDEX IF NOT EXISTS leads_tenant_phone_canonical ON leads(tenant_id,phone);
CREATE INDEX IF NOT EXISTS leads_tenant_email_normalized ON leads(tenant_id,lower(trim(email)));
COMMIT;
