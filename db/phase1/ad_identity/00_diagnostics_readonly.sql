-- READ-ONLY diagnostics for the ad identity migration. SELECTs only; run via
-- scripts/adIdentityDiagnostics.js (which enforces a read-only transaction) or psql in a
-- READ ONLY session. Not run against any database. Output contains IDs and counts, never tokens
-- or lead data. Each statement is separated by a line "-- @@ name".

-- @@ server_version
SELECT current_setting('server_version_num')::int AS server_version_num, current_setting('server_version') AS server_version;

-- @@ constraints_and_indexes
SELECT t.relname AS table_name, con.conname, con.contype, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = current_schema() AND t.relname IN ('ad_insights_daily','ad_campaigns','ad_adsets','ad_ads','ad_accounts')
  AND con.contype IN ('p','u')
ORDER BY 1, 2;

-- @@ table_sizes
SELECT c.relname AS table_name, c.reltuples::bigint AS approx_rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema() AND c.relname IN ('ad_insights_daily','ad_campaigns','ad_adsets','ad_ads') ORDER BY 1;

-- @@ scoped_columns_present
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name IN ('ad_insights_daily','ad_campaigns','ad_adsets','ad_ads')
  AND column_name IN ('entity_key','external_key','provider','currency','ad_account_id') ORDER BY 1, 2;

-- @@ accounts_per_provider
SELECT provider, count(*) AS accounts, count(DISTINCT tenant_id) AS tenants FROM ad_accounts GROUP BY provider;

-- @@ owner_mismatch_campaigns
-- Campaign rows whose insights are stamped with a different ad account than the campaign row's: evidence of
-- an external id seen under two accounts (legacy key let one overwrite the other).
SELECT ac.tenant_id, ac.external_id, ac.ad_account_id AS campaign_account, i.ad_account_id AS insights_account, count(*) AS insight_rows
FROM ad_campaigns ac JOIN ad_insights_daily i
  ON i.tenant_id = ac.tenant_id AND i.entity_type = 'campaign' AND i.entity_id = ac.external_id AND i.ad_account_id <> ac.ad_account_id
GROUP BY 1, 2, 3, 4 ORDER BY insight_rows DESC LIMIT 200;

-- @@ cross_provider_id_overlap
-- Same external id present for both providers within one tenant (Meta vs Google numeric id collision).
SELECT m.tenant_id, m.external_id
FROM ad_ads m JOIN ad_campaigns mc ON mc.id = (SELECT s.ad_campaign_id FROM ad_adsets s WHERE s.id = m.ad_adset_id)
JOIN ad_accounts ma ON ma.id = mc.ad_account_id AND ma.provider = 'meta'
WHERE EXISTS (
  SELECT 1 FROM ad_insights_daily g JOIN ad_accounts ga ON ga.id = g.ad_account_id AND ga.provider = 'google'
  WHERE g.tenant_id = m.tenant_id AND g.entity_type = 'ad' AND g.entity_id = m.external_id)
LIMIT 200;

-- @@ google_ad_adgroup_mismatch
-- Google ad insights rows whose adset_external_id differs from the ad row's parent ad group:
-- the bare-ad-id key made two ad groups share one row; these are overwrite-suspects.
SELECT i.tenant_id, i.ad_account_id, i.entity_id AS ad_id, i.adset_external_id AS insights_ad_group, s.external_id AS hierarchy_ad_group, count(*) AS insight_rows
FROM ad_insights_daily i
JOIN ad_accounts a ON a.id = i.ad_account_id AND a.provider = 'google'
JOIN ad_ads ad ON ad.tenant_id = i.tenant_id AND ad.external_id = i.entity_id
JOIN ad_adsets s ON s.id = ad.ad_adset_id
WHERE i.entity_type = 'ad' AND i.adset_external_id IS NOT NULL AND i.adset_external_id <> s.external_id
GROUP BY 1, 2, 3, 4, 5 ORDER BY insight_rows DESC LIMIT 200;

-- @@ google_ad_insights_missing_adgroup
-- Google ad insight rows that cannot receive a composite key in the backfill (adset_external_id NULL).
SELECT count(*) AS rows_without_ad_group
FROM ad_insights_daily i JOIN ad_accounts a ON a.id = i.ad_account_id AND a.provider = 'google'
WHERE i.entity_type = 'ad' AND i.adset_external_id IS NULL;

-- @@ rollup_reconciliation
-- Per account/date: campaign-level spend vs ad-level spend (Google Performance Max has no ads; informational).
SELECT c.ad_account_id, c.date, round(c.spend::numeric, 2) AS campaign_spend, round(coalesce(a.spend, 0)::numeric, 2) AS ad_spend
FROM (SELECT ad_account_id, date, sum(spend) AS spend FROM ad_insights_daily WHERE entity_type = 'campaign' GROUP BY 1, 2) c
LEFT JOIN (SELECT ad_account_id, date, sum(spend) AS spend FROM ad_insights_daily WHERE entity_type = 'ad' GROUP BY 1, 2) a
  ON a.ad_account_id = c.ad_account_id AND a.date = c.date
WHERE abs(c.spend - coalesce(a.spend, 0)) > 0.01
ORDER BY abs(c.spend - coalesce(a.spend, 0)) DESC LIMIT 200;
