BEGIN;
-- Configuration only. No sequences, rules, enrolments or messages are created.
-- Reuse the existing product field; older databases may predate its ingestion migration.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product TEXT;
ALTER TABLE automation_sequences ADD COLUMN IF NOT EXISTS stop_conditions JSONB NOT NULL DEFAULT '{"on_reply":true,"demo_booked":false,"customer_converted":false}';
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS product_interest TEXT;
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS always_template BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS template_language TEXT;
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS template_parameters JSONB NOT NULL DEFAULT '[]';
ALTER TABLE automation_sequence_steps ADD COLUMN IF NOT EXISTS reply_routes JSONB NOT NULL DEFAULT '[]';
ALTER TABLE automation_enrollments ALTER COLUMN cancelled_reason TYPE TEXT;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS claim_token UUID;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS claim_until TIMESTAMPTZ;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS awaiting_step INT;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS awaiting_since TIMESTAMPTZ;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS awaiting_routes JSONB NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS automation_send_attempts (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID NOT NULL REFERENCES tenants(id),
 enrollment_id UUID NOT NULL REFERENCES automation_enrollments(id) ON DELETE CASCADE,
 step_order INT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', attempts INT NOT NULL DEFAULT 0,
 wa_message_id TEXT, error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(enrollment_id, step_order)
);
CREATE TABLE IF NOT EXISTS automation_reply_events (
 tenant_id UUID NOT NULL REFERENCES tenants(id), message_id TEXT NOT NULL,
 lead_id UUID NOT NULL REFERENCES leads(id), enrollment_id UUID REFERENCES automation_enrollments(id) ON DELETE SET NULL,
 classification TEXT, outcome TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id, message_id)
);
-- Serialize appointment writes with the worker's final lead lock. All existing
-- manual/AI/API booking paths write lead_followups; no external calendar hook implied.
CREATE OR REPLACE FUNCTION automation_booking_stop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF lower(NEW.followup_type) = 'demo' AND NOT NEW.is_completed AND NEW.dismissed_at IS NULL THEN
  PERFORM 1 FROM leads WHERE id=NEW.lead_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  UPDATE automation_enrollments e SET status='cancelled', cancelled_at=now(),
    cancelled_reason='demo_booked', claim_token=NULL, claim_until=NULL, awaiting_step=NULL
  FROM automation_sequences s WHERE s.id=e.sequence_id AND s.tenant_id=e.tenant_id
    AND e.tenant_id=NEW.tenant_id AND e.lead_id=NEW.lead_id
    AND e.status IN ('active','blocked','failed','uncertain','human_review','awaiting_reply')
    AND COALESCE((s.stop_conditions->>'demo_booked')::boolean,false);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS automation_booking_stop ON lead_followups;
CREATE TRIGGER automation_booking_stop BEFORE INSERT OR UPDATE OF followup_type,is_completed,dismissed_at ON lead_followups
 FOR EACH ROW EXECUTE FUNCTION automation_booking_stop();
CREATE OR REPLACE FUNCTION automation_lead_stop() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE customer boolean; lost boolean;
BEGIN
 SELECT COALESCE(is_won,false),COALESCE(is_lost,false) INTO customer,lost FROM lead_stages
  WHERE tenant_id=NEW.tenant_id AND lower(name)=lower(NEW.stage) LIMIT 1;
 customer := COALESCE(customer,false) OR NEW.won_at IS NOT NULL;
 UPDATE automation_enrollments e SET status='cancelled', cancelled_at=now(),
   cancelled_reason=CASE WHEN NEW.opted_out THEN 'opted_out' WHEN lost THEN 'stage_lost' ELSE 'customer_converted' END,
   claim_token=NULL,claim_until=NULL,awaiting_step=NULL
 FROM automation_sequences s WHERE s.id=e.sequence_id AND s.tenant_id=e.tenant_id
   AND e.tenant_id=NEW.tenant_id AND e.lead_id=NEW.id
   AND e.status IN ('active','blocked','failed','uncertain','human_review','awaiting_reply')
   AND (NEW.opted_out OR COALESCE(lost,false) OR (customer AND COALESCE((s.stop_conditions->>'customer_converted')::boolean,false)));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS automation_lead_stop ON leads;
CREATE TRIGGER automation_lead_stop AFTER UPDATE OF stage,won_at,opted_out ON leads
 FOR EACH ROW EXECUTE FUNCTION automation_lead_stop();
COMMIT;
