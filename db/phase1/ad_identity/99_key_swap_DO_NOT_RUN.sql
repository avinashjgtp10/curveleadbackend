-- STEP 6: replace the legacy primary/unique keys. POINT OF NO RETURN once legitimate duplicates
-- (same external id in two accounts, or Google ad ids reused across ad groups) have been written.
-- DO NOT RUN without separate explicit approval. This file refuses to run unless the operator
-- opts in with:  psql -v confirm_key_swap=yes_i_have_approval -f 99_key_swap_DO_NOT_RUN.sql
\if :{?confirm_key_swap}
\else
  \echo 'Refusing: confirm_key_swap not set. This swap needs separate approval.'
  \quit
\endif
\if :'confirm_key_swap' = 'yes_i_have_approval'
\else
  \echo 'Refusing: wrong confirmation value.'
  \quit
\endif

-- One short transaction per table, in this order: insights, ads, ad sets, campaigns.
-- Uses the already-built scoped unique indexes, so no table rewrite and a brief lock.
-- Constraint names MUST be confirmed against 00_diagnostics output first (they are not assumed here).
-- Template (names to be filled from diagnostics, then reviewed):
--   BEGIN;
--   ALTER TABLE ad_insights_daily DROP CONSTRAINT <legacy_pk_name>;
--   ALTER TABLE ad_insights_daily ADD CONSTRAINT ad_insights_daily_pkey PRIMARY KEY USING INDEX ad_insights_daily_scoped_uq;
--   COMMIT;
-- (repeat for ad_ads, ad_adsets, ad_campaigns with their unique constraints)
\echo 'Template only: fill in verified constraint names, then re-review before enabling statements.'
