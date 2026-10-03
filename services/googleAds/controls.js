const db = require('../../config/db');
const gads = require('../../utils/googleAds');
const { getGoogleAccountWithToken } = require('./accounts');
const { effectiveStatus } = require('./sync');
const { dailyBudgetTotal, workspaceBudgets, budgetCap, audit, money } = require('../metaAds/controls');

// Phase 7b: pause/resume Google campaigns and ad groups, change a campaign's daily budget.
// Same order as the Meta controls: read the current value from Google (so the audit's old
// value is real), enforce the workspace's daily budget cap, write to Google, then update
// our cache and the audit log in one transaction.

const fail = (status, message) => Object.assign(new Error(message), { status });
const toPaise = (micros) => (micros == null || micros === '' ? null : Math.round(Number(micros) / 1e4));

const ENTITY = {
  campaign: {
    table: 'ad_campaigns', label: 'Campaign',
    sql: `SELECT ac.id, ac.external_id, ac.name, ac.ad_account_id, ac.campaign_id AS crm_campaign_id
          FROM ad_campaigns ac WHERE ac.tenant_id = $1 AND ac.id = $2`,
    gaql: (id) => `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status,
        campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.period, campaign_budget.total_amount_micros,
        campaign_budget.explicitly_shared, campaign_budget.reference_count
      FROM campaign WHERE campaign.id = ${gads.digits(id)}`,
  },
  adset: {
    table: 'ad_adsets', label: 'Ad group',
    sql: `SELECT s.id, s.external_id, s.name, ac.ad_account_id, ac.external_id AS campaign_external_id
          FROM ad_adsets s JOIN ad_campaigns ac ON ac.id = s.ad_campaign_id AND ac.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1 AND s.id = $2`,
    gaql: (id) => `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group WHERE ad_group.id = ${gads.digits(id)}`,
  },
};

// A Google row → the values we cache and audit.
const snapshot = (entityType, r) => {
  if (entityType === 'adset') return { name: r.adGroup?.name || null, status: r.adGroup?.status || null, effective_status: effectiveStatus(r.adGroup?.status) };
  const b = r.campaignBudget || {};
  const lifetime = b.period === 'CUSTOM_PERIOD';
  return {
    name: r.campaign?.name || null, status: r.campaign?.status || null, effective_status: effectiveStatus(r.campaign?.status, r.campaign?.servingStatus),
    daily_budget_paise: lifetime ? null : toPaise(b.amountMicros), lifetime_budget_paise: lifetime ? toPaise(b.totalAmountMicros) : null,
    budget_resource: b.resourceName || null, budget_shared: !!b.explicitlyShared, budget_campaigns: Number(b.referenceCount || 1),
  };
};

// Pure: the single mutate operation for a change.
const operationFor = ({ entityType, customerId, externalId, change, budgetResource }) => {
  const cid = gads.digits(customerId);
  if (change.daily_budget_paise != null) {
    return { campaignBudgetOperation: { update: { resourceName: budgetResource, amountMicros: String(change.daily_budget_paise * 1e4) }, updateMask: 'amount_micros' } };
  }
  return entityType === 'campaign'
    ? { campaignOperation: { update: { resourceName: `customers/${cid}/campaigns/${gads.digits(externalId)}`, status: change.status }, updateMask: 'status' } }
    : { adGroupOperation: { update: { resourceName: `customers/${cid}/adGroups/${gads.digits(externalId)}`, status: change.status }, updateMask: 'status' } };
};

// Account + access token for a Google ad account in this workspace.
const googleAccess = async (tenantId, adAccountId, deps = {}) => {
  const found = await (deps.getGoogleAccountWithToken || getGoogleAccountWithToken)(tenantId, adAccountId);
  if (!found) throw fail(404, 'Google Ads account not found.');
  if (!found.refreshToken || found.account.token_status !== 'active') throw fail(400, 'Google Ads access has expired — click Reconnect in Ads Manager → Google Ads.');
  const accessToken = await (deps.accessToken || gads.accessToken)(found.refreshToken);
  return { account: found.account, opts: { customerId: found.account.external_id, accessToken, loginCustomerId: found.account.login_customer_id } };
};

// action: 'pause' | 'resume' | 'update_budget' (with dailyBudgetPaise). deps for tests.
const changeEntity = async ({ tenantId, userId, entityType, id, action, dailyBudgetPaise }, deps = {}) => {
  const query = deps.query || db.query;
  const transaction = deps.transaction || db.transaction;
  const search = deps.search || gads.search;
  const mutate = deps.mutate || gads.mutate;
  const def = ENTITY[entityType];
  if (!def) throw fail(422, 'Unknown entity type.');
  const entity = (await query(def.sql, [tenantId, id])).rows[0];
  if (!entity) throw fail(404, `${def.label} not found.`);
  if (action === 'update_budget' && entityType === 'adset') throw fail(422, 'Google ad groups don\'t have their own budget — change the campaign\'s budget instead.');

  const { account, opts } = await googleAccess(tenantId, entity.ad_account_id, deps);
  const read = async () => (await search({ ...opts, gaql: def.gaql(entity.external_id) }))[0];
  const current = await read();
  if (!current) throw fail(404, `${def.label} wasn't found in Google Ads — it may have been removed. Click Sync now.`);
  const oldValue = snapshot(entityType, current);

  let change;
  if (action === 'pause') change = { status: 'PAUSED' };
  else if (action === 'resume') change = { status: 'ENABLED' };
  else if (action === 'update_budget') {
    if (!Number.isInteger(dailyBudgetPaise) || dailyBudgetPaise < 100) throw fail(422, `Enter a daily budget of at least ${money(100, account.currency)}.`);
    if (oldValue.lifetime_budget_paise) throw fail(422, 'This campaign has a total budget for its run, not a daily one. Change it in Google Ads.');
    if (!oldValue.budget_resource) throw fail(422, 'This campaign has no budget CurveLead can change. Change it in Google Ads.');
    if (oldValue.budget_shared || oldValue.budget_campaigns > 1) {
      throw fail(422, `This budget is shared by ${oldValue.budget_campaigns} campaigns, so changing it would change all of them. Change it in Google Ads → Shared library → Budgets.`);
    }
    change = { daily_budget_paise: dailyBudgetPaise };
  } else throw fail(422, 'Unknown action.');

  if (change.status && change.status === oldValue.status) return { unchanged: true, old_value: oldValue, new_value: oldValue };

  // Daily budget cap (shared with Meta): refuse changes that would push total daily spend above it.
  const cap = await (deps.budgetCap || budgetCap)(tenantId);
  if (cap && action !== 'pause' && entityType === 'campaign') {
    const { campaigns, adsets } = await (deps.workspaceBudgets || workspaceBudgets)(tenantId);
    const base = { [entity.external_id]: { status: oldValue.status, daily_budget_paise: oldValue.daily_budget_paise } };
    const before = dailyBudgetTotal(campaigns, adsets, base);
    const after = dailyBudgetTotal(campaigns, adsets, { [entity.external_id]: { ...base[entity.external_id], ...change } });
    if (after > cap && after > before) {
      throw fail(422, `This would raise your total daily ad budget to ${money(after, account.currency)}, above your cap of ${money(cap, account.currency)}. Lower another budget or raise the cap in Ads Manager settings.`);
    }
  }

  const operation = operationFor({ entityType, customerId: account.external_id, externalId: entity.external_id, change, budgetResource: oldValue.budget_resource });
  const base = { tenantId, userId, adAccountId: entity.ad_account_id, entityType, entityId: entity.external_id, entityName: oldValue.name || entity.name,
    action, oldValue, request: change, provider: 'google' };
  let response;
  try {
    response = await mutate({ ...opts, operations: [operation] });
  } catch (e) {
    await audit({ query }, { ...base, success: false, error: String(e.message).slice(0, 500), response: { code: e.code ?? null } });
    if (e.name === 'GoogleAdsError') throw fail(e.status === 503 ? 503 : 400, e.message);
    throw e;
  }

  const fresh = await read().catch(() => null);
  const after = fresh ? snapshot(entityType, fresh) : { ...oldValue, ...change };
  await transaction(async (client) => {
    if (entityType === 'campaign') {
      await client.query(`UPDATE ad_campaigns SET status = $3, effective_status = $4, daily_budget_paise = $5, synced_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, entity.id, after.status, after.effective_status, after.daily_budget_paise]);
      if (entity.crm_campaign_id) {
        await client.query(
          `UPDATE campaigns SET status = $3, daily_budget = COALESCE($4::numeric, daily_budget), budget = COALESCE($4::numeric, budget), updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, entity.crm_campaign_id, after.effective_status === 'ACTIVE' ? 'active' : 'paused', after.daily_budget_paise != null ? after.daily_budget_paise / 100 : null]);
      }
    } else {
      await client.query(`UPDATE ad_adsets SET status = $3, effective_status = $4, synced_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, entity.id, after.status, after.effective_status]);
    }
    await audit(client, { ...base, newValue: after, response, success: true });
  });
  return { old_value: oldValue, new_value: after };
};

module.exports = { changeEntity, snapshot, operationFor, googleAccess };
