const { query } = require('../config/db');
const { pollRecentLeads } = require('../services/metaLeads');

// Pulls Meta Lead Ads leads created in the last 24 hours for one tenant — the safety net
// for missed webhooks, shared by the Integrations "Sync Leads Now" button and the
// 30-minute background job. Older leads: Ads Manager → Lead Forms → Backfill.
const syncFacebookLeadsForTenant = async (tenantId) => {
  const { created, duplicate, skipped, token_expired } = await pollRecentLeads(tenantId, 24);
  if (token_expired) throw Object.assign(new Error('The Facebook Page login expired — reconnect Facebook in Integrations to keep importing lead-ad leads.'), { status: 400, code: 'PAGE_TOKEN_EXPIRED' });
  const last_synced_at = new Date().toISOString();
  await query(`UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('meta_leads_last_synced_at', $2::text) WHERE id=$1`, [tenantId, last_synced_at]);
  return { created, skipped: skipped + duplicate, last_synced_at };
};

module.exports = { syncFacebookLeadsForTenant };
