-- UAE telemarketing window is 09:00-18:00 local at most. The code enforces this ceiling regardless,
-- but keep the stored policy rows consistent with it. Idempotent; only ever narrows.
UPDATE voice_country_policies
   SET calling_hours_start = GREATEST(calling_hours_start, TIME '09:00'),
       calling_hours_end   = LEAST(calling_hours_end,   TIME '18:00'),
       updated_at = NOW()
 WHERE destination_country = 'AE'
   AND (calling_hours_start < TIME '09:00' OR calling_hours_end > TIME '18:00');
