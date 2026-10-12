-- Step 5 (after the rollout state is 'dual_write' AND the backfill finished). Run with psql OUTSIDE a transaction
-- (CREATE INDEX CONCURRENTLY cannot run in one).
-- Preconditions, all checked by scripts/adIdentityReadiness.js:
--   * rollout state is 'dual_write' (writers fill the keys). The key-present CHECKs below REJECT any row written
--     without its keys, so a legacy-mode writer would start failing the moment they exist.
--   * the backfill reports no backfillable rows, and the owner has resolved every "unresolvable" record
--     (Google ads with no ad group id are never given a guessed key; they would make VALIDATE fail).
-- Not applied to any database. Legacy unique keys stay in place; these indexes are ADDITIVE.
-- A failed CONCURRENTLY build leaves an INVALID index: drop it and retry (the application ignores invalid indexes
-- and a 'scoped' rollout degrades to dual_write while one is invalid).
-- Applying this file does NOT switch the application to scoped identity; only the rollout script does that.

-- 3a. "key present" checks: NOT VALID first (instant), then VALIDATE (scans, takes no blocking lock).
ALTER TABLE ad_insights_daily ADD CONSTRAINT ad_insights_entity_key_present CHECK (entity_key IS NOT NULL AND provider IS NOT NULL) NOT VALID;
ALTER TABLE ad_campaigns      ADD CONSTRAINT ad_campaigns_key_present      CHECK (external_key IS NOT NULL AND provider IS NOT NULL) NOT VALID;
ALTER TABLE ad_adsets         ADD CONSTRAINT ad_adsets_key_present         CHECK (external_key IS NOT NULL AND provider IS NOT NULL AND ad_account_id IS NOT NULL) NOT VALID;
ALTER TABLE ad_ads            ADD CONSTRAINT ad_ads_key_present            CHECK (external_key IS NOT NULL AND provider IS NOT NULL AND ad_account_id IS NOT NULL) NOT VALID;
ALTER TABLE ad_insights_daily VALIDATE CONSTRAINT ad_insights_entity_key_present;
ALTER TABLE ad_campaigns      VALIDATE CONSTRAINT ad_campaigns_key_present;
ALTER TABLE ad_adsets         VALIDATE CONSTRAINT ad_adsets_key_present;
ALTER TABLE ad_ads            VALIDATE CONSTRAINT ad_ads_key_present;

-- 3b. Account-scoped unique indexes. Names are what services/adIdentity.js probes for.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ad_campaigns_scoped_uq ON ad_campaigns (tenant_id, ad_account_id, external_key);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ad_adsets_scoped_uq    ON ad_adsets    (tenant_id, ad_account_id, external_key);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ad_ads_scoped_uq       ON ad_ads       (tenant_id, ad_account_id, external_key);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ad_insights_daily_scoped_uq ON ad_insights_daily (tenant_id, ad_account_id, entity_type, entity_key, date);

-- 3c. Verify: every row must be indisvalid = true, else the app stays in legacy mode.
SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname IN ('ad_insights_daily_scoped_uq','ad_campaigns_scoped_uq','ad_adsets_scoped_uq','ad_ads_scoped_uq');
