-- Phase 1 / ad identity, step 1 of 6: additive, nullable columns only.
-- Safe to run online: metadata-only ALTERs, no rewrite, no index, no constraint, no data change.
-- Adding these columns changes NO application behaviour: the application stays in 'legacy' mode until the
-- rollout state is explicitly changed with scripts/adIdentityRollout.js (see services/adIdentity.js).
-- Not yet applied to any database. Rollback: db/phase1/ad_identity/rollback_01_columns.sql

ALTER TABLE ad_insights_daily
  ADD COLUMN IF NOT EXISTS entity_key TEXT,        -- canonical key: Meta/Google campaign+ad group = id; Google ad = '<adGroupId>~<adId>'
  ADD COLUMN IF NOT EXISTS provider   VARCHAR(20), -- 'meta' | 'google', denormalized from ad_accounts
  ADD COLUMN IF NOT EXISTS currency   VARCHAR(10); -- denormalized from ad_accounts at write time (per-currency reporting)

ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS external_key TEXT,
  ADD COLUMN IF NOT EXISTS provider VARCHAR(20);

ALTER TABLE ad_adsets
  ADD COLUMN IF NOT EXISTS ad_account_id UUID,     -- denormalized from the parent campaign so the scoped key can be unique
  ADD COLUMN IF NOT EXISTS external_key TEXT,
  ADD COLUMN IF NOT EXISTS provider VARCHAR(20);

ALTER TABLE ad_ads
  ADD COLUMN IF NOT EXISTS ad_account_id UUID,
  ADD COLUMN IF NOT EXISTS external_key TEXT,      -- Google: '<adGroupId>~<adId>'
  ADD COLUMN IF NOT EXISTS provider VARCHAR(20);
