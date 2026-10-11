-- Our own copy of each AI call recording (the provider's link can expire), kept in our storage.
ALTER TABLE ai_voice_calls ADD COLUMN IF NOT EXISTS recording_s3_url TEXT;
ALTER TABLE ai_voice_calls ADD COLUMN IF NOT EXISTS recording_archived_at TIMESTAMP;
