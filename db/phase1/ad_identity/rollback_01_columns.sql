-- Reverts step 1. Safe only before step 3 indexes exist (drop those first with rollback_03_indexes.sql).
ALTER TABLE ad_insights_daily DROP COLUMN IF EXISTS entity_key, DROP COLUMN IF EXISTS provider, DROP COLUMN IF EXISTS currency;
ALTER TABLE ad_campaigns DROP COLUMN IF EXISTS external_key, DROP COLUMN IF EXISTS provider;
ALTER TABLE ad_adsets DROP COLUMN IF EXISTS ad_account_id, DROP COLUMN IF EXISTS external_key, DROP COLUMN IF EXISTS provider;
ALTER TABLE ad_ads DROP COLUMN IF EXISTS ad_account_id, DROP COLUMN IF EXISTS external_key, DROP COLUMN IF EXISTS provider;
