-- WhatsApp booking confirmations + reminders for demo/visit appointments.

-- Per-booking switch: staff can book without messaging the lead.
ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS notify_lead BOOLEAN NOT NULL DEFAULT true;

-- One row per message sent (or attempted) for a booking. booking_at is part of the
-- key, so rescheduling the same follow-up re-arms its reminders for the new time,
-- while the unique key stops the reminder job from ever sending one twice.
CREATE TABLE IF NOT EXISTS booking_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  followup_id uuid NOT NULL REFERENCES lead_followups(id) ON DELETE CASCADE,
  kind varchar(20) NOT NULL,                        -- confirmation | reminder_1 | reminder_2
  booking_at timestamp NOT NULL,                    -- lead_followups.next_followup_at (UTC) it was sent for
  status varchar(20) NOT NULL DEFAULT 'sending',    -- sending | sent | failed | skipped
  via varchar(20),                                  -- text | template
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (followup_id, kind, booking_at)
);

CREATE INDEX IF NOT EXISTS idx_followups_upcoming_bookings ON lead_followups(next_followup_at)
  WHERE is_completed = false AND dismissed_at IS NULL AND followup_type IN ('demo', 'visit');
