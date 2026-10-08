const { query, transaction } = require('../../config/db');
const { graphPaged } = require('../../utils/metaGraph');
const { findOrCreateMetaCampaign } = require('../../utils/metaCampaignMatch');
const { parseBudgetPaise } = require('./parseInsights');

// Campaign → adset → ad, with creative, in one field-expanded request per page of
// campaigns. Nested lists over 100 items are completed with their own paging.

const STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED',
  'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES'];

const AD_FIELDS = 'id,name,status,effective_status,creative{id,thumbnail_url,image_url,body,title,call_to_action_type}';
const ADSET_FIELDS = `id,name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting,promoted_object,ads.limit(100){${AD_FIELDS}}`;
const CAMPAIGN_FIELDS = `id,name,objective,status,effective_status,daily_budget,lifetime_budget,special_ad_categories,start_time,stop_time,adsets.limit(100){${ADSET_FIELDS}}`;

const completeNested = async (edge, token, gateKey) => {
  const rows = [...(edge?.data || [])];
  if (edge?.paging?.next) rows.push(...await graphPaged({ path: edge.paging.next, token, gateKey }));
  return rows;
};

const fetchHierarchy = async (externalAccountId, token) => {
  const gateKey = externalAccountId;
  const campaigns = await graphPaged({
    path: `/${externalAccountId}/campaigns`, token, gateKey,
    params: {
      fields: CAMPAIGN_FIELDS, limit: 25,
      filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: STATUSES }]),
    },
  });
  for (const c of campaigns) {
    c.adsets = await completeNested(c.adsets, token, gateKey);
    for (const s of c.adsets) s.ads = await completeNested(s.ads, token, gateKey);
  }
  return campaigns;
};

const creativeOf = (ad) => {
  const c = ad.creative || {};
  return { thumbnail_url: c.thumbnail_url || null, image_url: c.image_url || null, body: c.body || null, title: c.title || null, call_to_action_type: c.call_to_action_type || null };
};

// Upserts the hierarchy for one ad account. Each campaign is linked to (or creates)
// the CRM campaign row the rest of the app already uses for attribution.
const saveHierarchy = async ({ tenantId, adAccountId, campaigns }) => {
  const crmIds = new Map();
  for (const c of campaigns) crmIds.set(c.id, await findOrCreateMetaCampaign({ tenantId, campaignId: c.id, campaignName: c.name }));

  await transaction(async (client) => {
    for (const c of campaigns) {
      const { rows: [camp] } = await client.query(
        `INSERT INTO ad_campaigns (tenant_id, ad_account_id, external_id, campaign_id, name, objective, status, effective_status,
                                   daily_budget_paise, lifetime_budget_paise, special_ad_categories, start_time, stop_time, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
         ON CONFLICT (tenant_id, external_id) DO UPDATE SET
           ad_account_id = EXCLUDED.ad_account_id, campaign_id = COALESCE(EXCLUDED.campaign_id, ad_campaigns.campaign_id),
           name = EXCLUDED.name, objective = EXCLUDED.objective, status = EXCLUDED.status, effective_status = EXCLUDED.effective_status,
           daily_budget_paise = EXCLUDED.daily_budget_paise, lifetime_budget_paise = EXCLUDED.lifetime_budget_paise,
           special_ad_categories = EXCLUDED.special_ad_categories, start_time = EXCLUDED.start_time, stop_time = EXCLUDED.stop_time, synced_at = now()
         RETURNING id`,
        [tenantId, adAccountId, c.id, crmIds.get(c.id) || null, c.name || null, c.objective || null, c.status || null, c.effective_status || null,
          parseBudgetPaise(c.daily_budget), parseBudgetPaise(c.lifetime_budget), c.special_ad_categories || [], c.start_time || null, c.stop_time || null]
      );
      // Keep the CRM campaign's status/budget in step, as the legacy sync did.
      if (crmIds.get(c.id)) {
        await client.query(
          `UPDATE campaigns SET status = $3, daily_budget = COALESCE($4, daily_budget), lifetime_budget = COALESCE($5, lifetime_budget),
                  budget = COALESCE(NULLIF($5::numeric, 0), $4::numeric, budget), updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, crmIds.get(c.id), c.effective_status === 'ACTIVE' ? 'active' : 'paused',
            c.daily_budget ? Number(c.daily_budget) / 100 : null, c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null]
        );
      }
      for (const s of c.adsets || []) {
        const { rows: [set] } = await client.query(
          `INSERT INTO ad_adsets (tenant_id, ad_campaign_id, external_id, name, status, effective_status, daily_budget_paise, lifetime_budget_paise,
                                  optimization_goal, billing_event, targeting, promoted_object, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
           ON CONFLICT (tenant_id, external_id) DO UPDATE SET
             ad_campaign_id = EXCLUDED.ad_campaign_id, name = EXCLUDED.name, status = EXCLUDED.status, effective_status = EXCLUDED.effective_status,
             daily_budget_paise = EXCLUDED.daily_budget_paise, lifetime_budget_paise = EXCLUDED.lifetime_budget_paise,
             optimization_goal = EXCLUDED.optimization_goal, billing_event = EXCLUDED.billing_event,
             targeting = EXCLUDED.targeting, promoted_object = EXCLUDED.promoted_object, synced_at = now()
           RETURNING id`,
          [tenantId, camp.id, s.id, s.name || null, s.status || null, s.effective_status || null,
            parseBudgetPaise(s.daily_budget), parseBudgetPaise(s.lifetime_budget), s.optimization_goal || null, s.billing_event || null,
            s.targeting ? JSON.stringify(s.targeting) : null, s.promoted_object ? JSON.stringify(s.promoted_object) : null]
        );
        for (const ad of s.ads || []) {
          await client.query(
            `INSERT INTO ad_ads (tenant_id, ad_adset_id, external_id, name, status, effective_status, creative_id, creative, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
             ON CONFLICT (tenant_id, external_id) DO UPDATE SET
               ad_adset_id = EXCLUDED.ad_adset_id, name = EXCLUDED.name, status = EXCLUDED.status, effective_status = EXCLUDED.effective_status,
               creative_id = EXCLUDED.creative_id, creative = EXCLUDED.creative, synced_at = now()`,
            [tenantId, set.id, ad.id, ad.name || null, ad.status || null, ad.effective_status || null, ad.creative?.id || null, JSON.stringify(creativeOf(ad))]
          );
        }
      }
    }
  });
  return { campaigns: campaigns.length };
};

module.exports = { fetchHierarchy, saveHierarchy, CAMPAIGN_FIELDS, STATUSES };
