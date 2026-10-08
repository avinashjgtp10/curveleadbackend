const { query, transaction } = require('../../config/db');
const gads = require('../../utils/googleAds');
const { getGoogleAccountWithToken } = require('./accounts');
const { syncRange } = require('../metaAds/sync');

// Google Ads sync for one account: campaigns → ad groups → ads into ad_campaigns /
// ad_adsets / ad_ads, daily cost/impressions/clicks/conversions into ad_insights_daily,
// and the CRM campaign (campaigns.google_campaign_id) kept in step, the same way the
// Meta sync does. Google's "conversions" are stored as leads — they are what the
// advertiser counts as a conversion in Google Ads, which the UI labels as such.

const micros = (v) => (v == null || v === '' ? 0 : Number(v) / 1e6);
const toPaise = (v) => (v == null || v === '' ? null : Math.round(Number(v) / 1e4));
const id = (v) => (v == null ? null : String(v));

// Google status + serving status → the effective_status vocabulary the Ads screens use.
const effectiveStatus = (status, serving) => {
  if (status === 'PAUSED') return 'PAUSED';
  if (status === 'REMOVED') return 'DELETED';
  if (serving === 'ENDED') return 'ENDED';
  if (serving === 'PENDING') return 'PENDING';
  if (serving === 'SUSPENDED') return 'DISAPPROVED';
  return status === 'ENABLED' ? 'ACTIVE' : status || null;
};

const GAQL = {
  campaigns: `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type,
      campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.period, campaign_budget.total_amount_micros,
      campaign_budget.explicitly_shared
    FROM campaign WHERE campaign.status != 'REMOVED'`,
  adGroups: `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id
    FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`,
  ads: `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
      ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group.id
    FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED'`,
  lifetime: 'SELECT campaign.id, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign',
  daily: (level, since, until) => {
    const sel = { campaign: 'campaign.id', ad_group: 'campaign.id, ad_group.id', ad_group_ad: 'campaign.id, ad_group.id, ad_group_ad.ad.id' }[level];
    return `SELECT ${sel}, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
      FROM ${level} WHERE segments.date BETWEEN '${since}' AND '${until}'`;
  },
};

// ── pure parsers (REST rows use camelCase) ─────────────────────────────────
const parseCampaign = (r) => {
  const b = r.campaignBudget || {};
  const daily = b.period === 'CUSTOM_PERIOD' ? null : toPaise(b.amountMicros);
  return {
    external_id: id(r.campaign.id), name: r.campaign.name, objective: r.campaign.advertisingChannelType || null,
    status: r.campaign.status, effective_status: effectiveStatus(r.campaign.status, r.campaign.servingStatus),
    daily_budget_paise: daily, lifetime_budget_paise: b.period === 'CUSTOM_PERIOD' ? toPaise(b.totalAmountMicros) : null,
    budget_resource: b.resourceName || null, budget_shared: !!b.explicitlyShared,
  };
};
const parseAdGroup = (r) => ({
  external_id: id(r.adGroup.id), campaign_external_id: id(r.campaign.id), name: r.adGroup.name,
  status: r.adGroup.status, effective_status: effectiveStatus(r.adGroup.status), optimization_goal: r.adGroup.type || null,
});
const parseAd = (r) => {
  const ad = r.adGroupAd.ad || {};
  const rsa = ad.responsiveSearchAd || {};
  const headlines = (rsa.headlines || []).map(h => h.text).filter(Boolean);
  const descriptions = (rsa.descriptions || []).map(d => d.text).filter(Boolean);
  const approval = r.adGroupAd.policySummary?.approvalStatus;
  return {
    external_id: id(ad.id), adset_external_id: id(r.adGroup.id), name: ad.name || headlines[0] || `${ad.type || 'Ad'} ${ad.id}`,
    status: r.adGroupAd.status,
    effective_status: approval === 'DISAPPROVED' ? 'DISAPPROVED' : effectiveStatus(r.adGroupAd.status),
    creative: { title: headlines[0] || null, body: descriptions[0] || null, headlines, descriptions, final_url: (ad.finalUrls || [])[0] || null, type: ad.type || null },
  };
};
// One metrics row → an ad_insights_daily row. leads = conversions (rounded; Google reports fractions).
const parseMetrics = (r, level) => {
  const m = r.metrics || {};
  const spend = Number(micros(m.costMicros).toFixed(2));
  const impressions = Number(m.impressions || 0), clicks = Number(m.clicks || 0);
  const conversions = Number(m.conversions || 0);
  const leads = Math.round(conversions);
  return {
    entity_id: level === 'campaign' ? id(r.campaign.id) : level === 'adset' ? id(r.adGroup.id) : id(r.adGroupAd.ad.id),
    date: r.segments.date, spend, impressions, clicks,
    ctr: impressions ? Number(((clicks * 100) / impressions).toFixed(4)) : null,
    cpc: clicks ? Number((spend / clicks).toFixed(4)) : null,
    leads, cpl: leads ? Number((spend / leads).toFixed(2)) : null,
    actions: { conversions },
    campaign_external_id: id(r.campaign?.id), adset_external_id: level === 'ad' ? id(r.adGroup?.id) : level === 'adset' ? id(r.adGroup?.id) : null,
  };
};

// CRM campaign for a Google campaign (created on first sight, like Meta's).
const findOrCreateGoogleCampaign = async (db, { tenantId, googleCampaignId, name }) => (await db.query(
  `INSERT INTO campaigns (tenant_id, name, source, status, google_campaign_id)
   VALUES ($1, $2, 'google_ads', 'active', $3)
   ON CONFLICT (tenant_id, google_campaign_id) WHERE google_campaign_id IS NOT NULL DO UPDATE SET updated_at = campaigns.updated_at
   RETURNING id`, [tenantId, name || `Google Ads campaign ${googleCampaignId}`, googleCampaignId])).rows[0].id;

const saveHierarchy = async ({ tenantId, adAccountId, campaigns, adGroups, ads }) => transaction(async (client) => {
  const campaignIds = new Map(), groupIds = new Map();
  for (const c of campaigns) {
    const crmId = await findOrCreateGoogleCampaign(client, { tenantId, googleCampaignId: c.external_id, name: c.name });
    const { rows } = await client.query(
      `INSERT INTO ad_campaigns (tenant_id, ad_account_id, external_id, campaign_id, name, objective, status, effective_status, daily_budget_paise, lifetime_budget_paise,
                                 budget_resource, budget_shared, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (tenant_id, external_id) DO UPDATE SET ad_account_id = EXCLUDED.ad_account_id, campaign_id = COALESCE(ad_campaigns.campaign_id, EXCLUDED.campaign_id),
         name = EXCLUDED.name, objective = EXCLUDED.objective, status = EXCLUDED.status, effective_status = EXCLUDED.effective_status,
         daily_budget_paise = EXCLUDED.daily_budget_paise, lifetime_budget_paise = EXCLUDED.lifetime_budget_paise,
         budget_resource = EXCLUDED.budget_resource, budget_shared = EXCLUDED.budget_shared, synced_at = now()
       RETURNING id, campaign_id`,
      [tenantId, adAccountId, c.external_id, crmId, c.name, c.objective, c.status, c.effective_status, c.daily_budget_paise, c.lifetime_budget_paise,
        c.budget_resource || null, !!c.budget_shared]);
    campaignIds.set(c.external_id, rows[0].id);
    await client.query(
      `UPDATE campaigns SET status = $3, daily_budget = COALESCE($4, daily_budget), lifetime_budget = COALESCE($5, lifetime_budget),
              budget = COALESCE(NULLIF($5::numeric, 0), $4::numeric, budget), updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, rows[0].campaign_id, c.effective_status === 'ACTIVE' ? 'active' : 'paused',
        c.daily_budget_paise != null ? c.daily_budget_paise / 100 : null, c.lifetime_budget_paise != null ? c.lifetime_budget_paise / 100 : null]);
    // Lead-form leads that arrived before the campaign was known.
    await client.query(
      'UPDATE leads SET campaign_id = $3 WHERE tenant_id = $1 AND google_campaign_id = $2 AND campaign_id IS NULL AND merged_into_id IS NULL',
      [tenantId, c.external_id, rows[0].campaign_id]);
  }
  for (const g of adGroups) {
    const parent = campaignIds.get(g.campaign_external_id);
    if (!parent) continue;
    const { rows } = await client.query(
      `INSERT INTO ad_adsets (tenant_id, ad_campaign_id, external_id, name, status, effective_status, optimization_goal, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (tenant_id, external_id) DO UPDATE SET ad_campaign_id = EXCLUDED.ad_campaign_id, name = EXCLUDED.name, status = EXCLUDED.status,
         effective_status = EXCLUDED.effective_status, optimization_goal = EXCLUDED.optimization_goal, synced_at = now()
       RETURNING id`, [tenantId, parent, g.external_id, g.name, g.status, g.effective_status, g.optimization_goal]);
    groupIds.set(g.external_id, rows[0].id);
  }
  for (const a of ads) {
    const parent = groupIds.get(a.adset_external_id);
    if (!parent) continue;
    await client.query(
      `INSERT INTO ad_ads (tenant_id, ad_adset_id, external_id, name, status, effective_status, creative, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (tenant_id, external_id) DO UPDATE SET ad_adset_id = EXCLUDED.ad_adset_id, name = EXCLUDED.name, status = EXCLUDED.status,
         effective_status = EXCLUDED.effective_status, creative = EXCLUDED.creative, synced_at = now()`,
      [tenantId, parent, a.external_id, a.name, a.status, a.effective_status, JSON.stringify(a.creative)]);
  }
});

// Campaign rows come straight from Google (so Performance Max, which has no ad groups
// or ads, is counted); ad group and ad rows are the drill-down; the account row is the
// sum of campaigns.
const saveDailyMetrics = async ({ tenantId, adAccountId, externalAccountId, since, until, rows }) => transaction(async (client) => {
  await client.query('DELETE FROM ad_insights_daily WHERE tenant_id = $1 AND ad_account_id = $2 AND date BETWEEN $3 AND $4', [tenantId, adAccountId, since, until]);
  let saved = 0;
  for (const [level, list] of Object.entries(rows)) {
    if (!list.length) continue;
    await client.query(
      `INSERT INTO ad_insights_daily (tenant_id, ad_account_id, entity_type, entity_id, date, spend, impressions, clicks, ctr, cpc, leads, cpl, actions, campaign_external_id, adset_external_id)
       SELECT $1, $2, $3, r.entity_id, r.date, r.spend, r.impressions, r.clicks, r.ctr, r.cpc, r.leads, r.cpl, r.actions, r.campaign_external_id, r.adset_external_id
       FROM jsonb_to_recordset($4::jsonb) AS r(entity_id text, date date, spend numeric, impressions bigint, clicks bigint, ctr numeric, cpc numeric,
            leads int, cpl numeric, actions jsonb, campaign_external_id text, adset_external_id text)
       ON CONFLICT (tenant_id, entity_type, entity_id, date) DO UPDATE SET ad_account_id = EXCLUDED.ad_account_id, spend = EXCLUDED.spend,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc, leads = EXCLUDED.leads, cpl = EXCLUDED.cpl,
         actions = EXCLUDED.actions, campaign_external_id = EXCLUDED.campaign_external_id, adset_external_id = EXCLUDED.adset_external_id, synced_at = now()`,
      [tenantId, adAccountId, level, JSON.stringify(list)]);
    saved += list.length;
  }
  await client.query(
    `INSERT INTO ad_insights_daily (tenant_id, ad_account_id, entity_type, entity_id, date, spend, impressions, clicks, ctr, cpc, leads, cpl)
     SELECT $1, $2, 'account', $5, date, sum(spend), sum(impressions), sum(clicks),
            CASE WHEN sum(impressions) > 0 THEN round(sum(clicks)::numeric * 100 / sum(impressions), 4) END,
            CASE WHEN sum(clicks) > 0 THEN round(sum(spend) / sum(clicks), 4) END,
            sum(leads), CASE WHEN sum(leads) > 0 THEN round(sum(spend) / sum(leads), 2) END
     FROM ad_insights_daily WHERE tenant_id = $1 AND ad_account_id = $2 AND entity_type = 'campaign' AND date BETWEEN $3 AND $4
     GROUP BY date
     ON CONFLICT (tenant_id, entity_type, entity_id, date) DO UPDATE SET spend = EXCLUDED.spend, impressions = EXCLUDED.impressions,
       clicks = EXCLUDED.clicks, ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc, leads = EXCLUDED.leads, cpl = EXCLUDED.cpl, synced_at = now()`,
    [tenantId, adAccountId, since, until, externalAccountId]);
  return saved;
});

const syncGoogleAccount = async ({ tenantId, adAccountId }, deps = {}) => {
  const found = await (deps.getGoogleAccountWithToken || getGoogleAccountWithToken)(tenantId, adAccountId);
  if (!found) return { skipped: 'not_found' };
  const { account, refreshToken } = found;
  if (!account.is_active) return { skipped: 'inactive' };
  const setError = (msg) => query('UPDATE ad_accounts SET sync_error = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId, adAccountId, String(msg).slice(0, 500)]);
  if (!refreshToken || account.token_status !== 'active') { await setError('Reconnect Google Ads: the connection is missing or expired.'); return { skipped: 'no_token' }; }

  const search = deps.search || gads.search;
  try {
    const accessToken = await (deps.accessToken || gads.accessToken)(refreshToken);
    const opts = { customerId: account.external_id, accessToken, loginCustomerId: account.login_customer_id };
    const [campaigns, adGroups, ads] = await Promise.all([
      search({ ...opts, gaql: GAQL.campaigns }), search({ ...opts, gaql: GAQL.adGroups }), search({ ...opts, gaql: GAQL.ads }),
    ]);
    await saveHierarchy({ tenantId, adAccountId, campaigns: campaigns.map(parseCampaign), adGroups: adGroups.map(parseAdGroup), ads: ads.map(parseAd) });

    const range = syncRange(account);
    const [c, g, a] = await Promise.all(['campaign', 'ad_group', 'ad_group_ad'].map(level => search({ ...opts, gaql: GAQL.daily(level, range.since, range.until) })));
    const saved = await saveDailyMetrics({ tenantId, adAccountId, externalAccountId: account.external_id, ...range,
      rows: { campaign: c.map(r => parseMetrics(r, 'campaign')), adset: g.map(r => parseMetrics(r, 'adset')), ad: a.map(r => parseMetrics(r, 'ad')) } });

    // Lifetime totals on the CRM campaign (Campaigns cards show these).
    for (const r of await search({ ...opts, gaql: GAQL.lifetime })) {
      await query(`UPDATE campaigns SET actual_spend = $3, impressions = $4, clicks = $5, updated_at = now() WHERE tenant_id = $1 AND google_campaign_id = $2`,
        [tenantId, id(r.campaign.id), Number(micros(r.metrics?.costMicros).toFixed(2)), Number(r.metrics?.impressions || 0), Number(r.metrics?.clicks || 0)]);
    }
    await query(`UPDATE ad_accounts SET last_synced_at = now(), insights_synced_through = $3, sync_error = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, adAccountId, range.until]);
    return { campaigns: campaigns.length, insight_rows: saved, ...range };
  } catch (e) {
    if (e.auth && account.token_row_id) {
      await query("UPDATE ad_oauth_tokens SET status = 'expired', last_error = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, account.token_row_id, e.message]);
    }
    await setError(e.message);
    throw e;
  }
};

module.exports = { syncGoogleAccount, saveHierarchy, parseCampaign, parseAdGroup, parseAd, parseMetrics, effectiveStatus, findOrCreateGoogleCampaign, GAQL };
