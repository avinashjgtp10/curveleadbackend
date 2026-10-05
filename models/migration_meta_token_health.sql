-- Meta login health: when Facebook invalidates a login (Graph error 190), the connection is
-- marked expired with the time and Facebook's subcode, and jobs stop retrying it. Also keeps
-- the permissions the person declined at login. Additive only; safe to re-run.
-- Apply: psql -v ON_ERROR_STOP=1 -f models/migration_meta_token_health.sql
-- (The Page login used for lead ads lives in tenants.settings: meta_page_token_status,
--  meta_page_token_expired_at, meta_page_token_error_subcode — no column needed.)
BEGIN;

-- Ads Manager / Social login (one row per Facebook user per workspace).
ALTER TABLE ad_oauth_tokens ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE ad_oauth_tokens ADD COLUMN IF NOT EXISTS error_subcode int;
-- scopes = granted at the last connect; declined_scopes = turned off by the person.
ALTER TABLE ad_oauth_tokens ADD COLUMN IF NOT EXISTS declined_scopes text[] NOT NULL DEFAULT '{}';

-- Facebook Page / Instagram accounts used for posting.
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS error_subcode int;

COMMIT;
