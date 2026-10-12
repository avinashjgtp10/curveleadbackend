-- Reverts step 5. Run outside a transaction.
-- ORDER MATTERS: first `node scripts/adIdentityRollout.js set dual_write` (instant rollback of scoped reads/writes),
-- then run this file. Only after the CHECK constraints below are gone may the rollout move on to 'legacy'
-- (the rollout script refuses 'legacy' while they exist, because legacy-mode writers do not fill the keys).
DROP INDEX CONCURRENTLY IF EXISTS ad_insights_daily_scoped_uq;
DROP INDEX CONCURRENTLY IF EXISTS ad_campaigns_scoped_uq;
DROP INDEX CONCURRENTLY IF EXISTS ad_adsets_scoped_uq;
DROP INDEX CONCURRENTLY IF EXISTS ad_ads_scoped_uq;
-- Constraints added NOT VALID / validated in step 3:
ALTER TABLE ad_insights_daily DROP CONSTRAINT IF EXISTS ad_insights_entity_key_present;
ALTER TABLE ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_key_present;
ALTER TABLE ad_adsets DROP CONSTRAINT IF EXISTS ad_adsets_key_present;
ALTER TABLE ad_ads DROP CONSTRAINT IF EXISTS ad_ads_key_present;
