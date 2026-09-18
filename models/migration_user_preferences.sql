-- Per-user app preferences (e.g. hidden lead-pipeline stages), synced across web and mobile.
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';
