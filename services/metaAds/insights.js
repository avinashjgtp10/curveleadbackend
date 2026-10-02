const { query, transaction } = require('../../config/db');
const { graphRequest, graphPaged } = require('../../utils/metaGraph');
const { parseInsightsRow } = require('./parseInsights');

// Daily ad-level insights via an async report (reliable for long ranges and big
// accounts), then rolled up to adset / campaign / account in SQL so every level
// comes from one Meta call and always adds up.

const FIELDS = 'campaign_id,adset_id,ad_id,date_start,spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchDailyAdInsights = async (externalAccountId, token, { since, until }, { _sleep = sleep, maxPolls = 200 } = {}) => {
  const gateKey = externalAccountId;
  const { report_run_id: runId } = await graphRequest({
    path: `/${externalAccountId}/insights`, method: 'POST', token, gateKey,
    data: { level: 'ad', time_increment: 1, time_range: { since, until }, fields: FIELDS, use_account_attribution_setting: true },
  });
  if (!runId) throw new Error('Meta did not return an insights report id.');

  for (let i = 0; ; i++) {
    const status = await graphRequest({ path: `/${runId}`, token, gateKey, params: { fields: 'async_status,async_percent_completion' } });
    if (status.async_status === 'Job Completed') break;
    if (['Job Failed', 'Job Skipped'].includes(status.async_status)) throw new Error(`Meta insights report ${status.async_status.toLowerCase()}.`);
    if (i >= maxPolls) throw new Error('Meta insights report timed out.');
    await _sleep(Math.min(15000, 2000 + i * 1000));
  }
  return graphPaged({ path: `/${runId}/insights`, token, gateKey, params: { limit: 500 } });
};

// Replaces the account's ad rows for [since, until] with fresh ones and rebuilds
// the rolled-up rows for the same range.
const saveDailyInsights = async ({ tenantId, adAccountId, externalAccountId, since, until, rows }) => {
  const parsed = rows.filter((r) => r.ad_id && r.date_start).map((r) => ({
    entity_id: r.ad_id, campaign_external_id: r.campaign_id || null, adset_external_id: r.adset_id || null, ...parseInsightsRow(r),
  }));

  await transaction(async (client) => {
    await client.query(
      'DELETE FROM ad_insights_daily WHERE tenant_id = $1 AND ad_account_id = $2 AND date BETWEEN $3 AND $4',
      [tenantId, adAccountId, since, until]
    );
    if (parsed.length) {
      await client.query(
        `INSERT INTO ad_insights_daily (tenant_id, ad_account_id, entity_type, entity_id, date, spend, impressions, clicks, ctr, cpc, leads, cpl,
                                        actions, cost_per_action_type, campaign_external_id, adset_external_id)
         SELECT $1, $2, 'ad', r.entity_id, r.date, r.spend, r.impressions, r.clicks, r.ctr, r.cpc, r.leads, r.cpl,
                r.actions, r.cost_per_action_type, r.campaign_external_id, r.adset_external_id
         FROM jsonb_to_recordset($3::jsonb) AS r(entity_id text, date date, spend numeric, impressions bigint, clicks bigint, ctr numeric,
              cpc numeric, leads int, cpl numeric, actions jsonb, cost_per_action_type jsonb, campaign_external_id text, adset_external_id text)
         ON CONFLICT (tenant_id, entity_type, entity_id, date) DO UPDATE SET
           ad_account_id = EXCLUDED.ad_account_id, spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
           ctr = EXCLUDED.ctr, cpc = EXCLUDED.cpc, leads = EXCLUDED.leads, cpl = EXCLUDED.cpl, actions = EXCLUDED.actions,
           cost_per_action_type = EXCLUDED.cost_per_action_type, campaign_external_id = EXCLUDED.campaign_external_id,
           adset_external_id = EXCLUDED.adset_external_id, synced_at = now()`,
        [tenantId, adAccountId, JSON.stringify(parsed)]
      );
    }
    // Roll-ups: CTR/CPC/CPL recomputed from the summed totals, not averaged.
    for (const [level, key] of [['adset', 'adset_external_id'], ['campaign', 'campaign_external_id'], ['account', `$5::text`]]) {
      await client.query(
        `INSERT INTO ad_insights_daily (tenant_id, ad_account_id, entity_type, entity_id, date, spend, impressions, clicks, ctr, cpc, leads, cpl,
                                        campaign_external_id, adset_external_id)
         SELECT $1, $2, '${level}', ${key}, date, sum(spend), sum(impressions), sum(clicks),
                CASE WHEN sum(impressions) > 0 THEN round(sum(clicks)::numeric * 100 / sum(impressions), 4) END,
                CASE WHEN sum(clicks) > 0 THEN round(sum(spend) / sum(clicks), 4) END,
                sum(leads),
                CASE WHEN sum(leads) > 0 THEN round(sum(spend) / sum(leads), 2) END,
                ${level === 'adset' ? 'min(campaign_external_id)' : level === 'campaign' ? 'campaign_external_id' : 'NULL'},
                ${level === 'adset' ? 'adset_external_id' : 'NULL'}
         FROM ad_insights_daily
         WHERE tenant_id = $1 AND ad_account_id = $2 AND entity_type = 'ad' AND date BETWEEN $3 AND $4
           ${level === 'account' ? '' : `AND ${key} IS NOT NULL`}
         GROUP BY ${level === 'account' ? 'date' : `${key}, date`}
         ON CONFLICT (tenant_id, entity_type, entity_id, date) DO UPDATE SET
           spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, ctr = EXCLUDED.ctr,
           cpc = EXCLUDED.cpc, leads = EXCLUDED.leads, cpl = EXCLUDED.cpl, synced_at = now()`,
        level === 'account' ? [tenantId, adAccountId, since, until, externalAccountId] : [tenantId, adAccountId, since, until]
      );
    }
  });
  return parsed.length;
};

module.exports = { fetchDailyAdInsights, saveDailyInsights, FIELDS };
