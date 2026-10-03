// Turns "the database is behind the code" errors into an actionable message naming the
// migration to run, instead of a bare 500. Postgres: 42P01 undefined table,
// 42703 undefined column, 42P10 no unique index matching an ON CONFLICT clause.
const MIGRATION_FOR = [
  [/budget_resource|budget_shared|ad_ai_drafts\.provider|ad_audit_log\.provider|"provider" of relation "ad_(ai_drafts|audit_log)"|column (?:\w+\.)?provider does not exist/, 'models/migration_ads_phase7b.sql'],
  [/login_customer_id|google_campaign_id/, 'models/migration_ads_phase7.sql'],
  [/social_accounts|social_posts|social_post_targets|next_attempt_at/, 'models/migration_ads_phase6.sql'],
  [/ad_ai_drafts/, 'models/migration_ads_phase5.sql'],
  [/ad_audit_log/, 'models/migration_ads_phase3.sql'],
  [/last_error|sent_at|event_id|meta_capi/, 'models/migration_ads_phase4.sql'],
  [/ad_lead_forms|meta_form_id|meta_lead_unique/, 'models/migration_ads_phase2.sql'],
  [/ad_accounts|ad_oauth_tokens|ad_campaigns|ad_adsets|ad_ads|ad_insights_daily|is_qualified/, 'models/migration_ads_phase1.sql'],
];

const isSchemaError = (e) => ['42P01', '42703', '42P10'].includes(e?.code);

const schemaErrorMessage = (e) => {
  const migration = MIGRATION_FOR.find(([re]) => re.test(e?.message || ''))?.[1];
  return `This feature needs a database update that hasn't been applied yet${migration ? ` (${migration})` : ''}. Ask your administrator to run it.`;
};

module.exports = { isSchemaError, schemaErrorMessage };
