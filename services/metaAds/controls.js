const { query, transaction } = require('../../config/db');
const { graphRequest } = require('../../utils/metaGraph');
const { getAccountWithToken } = require('./client');
const { parseBudgetPaise } = require('./parseInsights');

// Phase 3: pause/resume campaigns and ad sets, change daily budgets — always read from
// Meta first (so the audit's old value is real), enforce the workspace's daily budget cap,
// write to Meta, then update our cache and the audit log in one transaction.

const fail = (status, message) => Object.assign(new Error(message), { status });
const rupees = (paise) => `₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const ENTITY = {
  campaign: {
    table: 'ad_campaigns',
    sql: `SELECT ac.id, ac.external_id, ac.name, ac.ad_account_id, ac.campaign_id AS crm_campaign_id
          FROM ad_campaigns ac WHERE ac.tenant_id = $1 AND ac.id = $2`,
    fields: 'name,status,effective_status,daily_budget,lifetime_budget',
  },
  adset: {
    table: 'ad_adsets',
    sql: `SELECT s.id, s.external_id, s.name, ac.ad_account_id, ac.external_id AS campaign_external_id
          FROM ad_adsets s JOIN ad_campaigns ac ON ac.id = s.ad_campaign_id AND ac.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1 AND s.id = $2`,
    fields: 'name,status,effective_status,daily_budget,lifetime_budget,campaign{daily_budget,lifetime_budget}',
  },
};

// Total daily budget (paise) that is set to spend, the way Meta spends it: a campaign with
// its own budget (Advantage campaign budget / CBO) counts once; otherwise each active ad set
// counts. Uses the configured status, so a paused campaign or ad set counts nothing.
// `overrides` maps external id → { status?, daily_budget_paise? } to price a proposed change.
const dailyBudgetTotal = (campaigns, adsets, overrides = {}) => {
  const view = (row) => ({ ...row, ...(overrides[row.external_id] || {}) });
  const byCampaign = new Map();
  let total = 0;
  for (const c of campaigns.map(view)) {
    const cbo = c.daily_budget_paise != null || c.lifetime_budget_paise != null;
    byCampaign.set(c.external_id, { active: c.status === 'ACTIVE', cbo });
    if (c.status === 'ACTIVE' && c.daily_budget_paise) total += Number(c.daily_budget_paise);
  }
  for (const s of adsets.map(view)) {
    const c = byCampaign.get(s.campaign_external_id);
    if (c?.active && !c.cbo && s.status === 'ACTIVE' && s.daily_budget_paise) total += Number(s.daily_budget_paise);
  }
  return total;
};

const workspaceBudgets = async (tenantId) => {
  const [campaigns, adsets] = await Promise.all([
    query("SELECT external_id, status, daily_budget_paise, lifetime_budget_paise FROM ad_campaigns WHERE tenant_id = $1", [tenantId]),
    query(`SELECT s.external_id, s.status, s.daily_budget_paise, ac.external_id AS campaign_external_id
           FROM ad_adsets s JOIN ad_campaigns ac ON ac.id = s.ad_campaign_id AND ac.tenant_id = s.tenant_id WHERE s.tenant_id = $1`, [tenantId]),
  ]);
  return { campaigns: campaigns.rows, adsets: adsets.rows };
};

const budgetCap = async (tenantId) => {
  const { rows } = await query("SELECT settings->>'ads_daily_budget_cap_paise' AS cap FROM tenants WHERE id = $1", [tenantId]);
  const cap = Number(rows[0]?.cap);
  return Number.isInteger(cap) && cap > 0 ? cap : null;
};

const audit = (db, row) => db.query(
  `INSERT INTO ad_audit_log (tenant_id, user_id, ad_account_id, entity_type, entity_id, entity_name, action, old_value, new_value, request, response, success, error)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [row.tenantId, row.userId || null, row.adAccountId, row.entityType, row.entityId, row.entityName || null, row.action,
    JSON.stringify(row.oldValue || null), JSON.stringify(row.newValue || null), JSON.stringify(row.request || null),
    JSON.stringify(row.response || null), row.success, row.error || null]
);

const snapshot = (meta) => ({
  status: meta.status || null, effective_status: meta.effective_status || null,
  daily_budget_paise: parseBudgetPaise(meta.daily_budget), lifetime_budget_paise: parseBudgetPaise(meta.lifetime_budget),
});

// action: 'pause' | 'resume' | 'update_budget' (with dailyBudgetPaise)
const changeEntity = async ({ tenantId, userId, entityType, id, action, dailyBudgetPaise }) => {
  const def = ENTITY[entityType];
  if (!def) throw fail(422, 'Unknown entity type.');
  const entity = (await query(def.sql, [tenantId, id])).rows[0];
  if (!entity) throw fail(404, `${entityType === 'adset' ? 'Ad set' : 'Campaign'} not found.`);

  const found = await getAccountWithToken(tenantId, entity.ad_account_id);
  if (!found?.token || found.account.token_status !== 'active') throw fail(400, 'Facebook access has expired — click Reconnect in Ads Manager → Meta Ads.');
  const { account, token } = found;
  const scopes = (await query('SELECT scopes FROM ad_oauth_tokens WHERE tenant_id = $1 AND id = $2', [tenantId, account.token_row_id])).rows[0]?.scopes || [];
  if (!scopes.includes('ads_management')) {
    throw fail(403, 'CurveLead can only read these ads. Click Reconnect in Ads Manager → Meta Ads and allow "Manage your ads" to pause, resume or change budgets.');
  }

  const gateKey = account.external_id;
  const current = await graphRequest({ path: `/${entity.external_id}`, token, gateKey, params: { fields: def.fields } });
  const oldValue = snapshot(current);

  let change;
  if (action === 'pause') change = { status: 'PAUSED' };
  else if (action === 'resume') change = { status: 'ACTIVE' };
  else if (action === 'update_budget') {
    if (!Number.isInteger(dailyBudgetPaise) || dailyBudgetPaise < 100) throw fail(422, 'Enter a daily budget of at least ₹1.');
    if (oldValue.lifetime_budget_paise) throw fail(422, 'This uses a lifetime budget. Change it in Meta Ads Manager.');
    if (entityType === 'adset' && (current.campaign?.daily_budget || current.campaign?.lifetime_budget)) {
      throw fail(422, 'This campaign uses Advantage campaign budget, so the budget is set on the campaign, not its ad sets.');
    }
    if (entityType === 'campaign' && !oldValue.daily_budget_paise) {
      throw fail(422, "This campaign's budget is set on its ad sets. Change the ad set budgets instead.");
    }
    change = { daily_budget_paise: dailyBudgetPaise };
  } else throw fail(422, 'Unknown action.');

  if (change.status && change.status === oldValue.status) return { unchanged: true, old_value: oldValue, new_value: oldValue };

  // Daily budget cap: refuse changes that would push total daily spend above it.
  const cap = await budgetCap(tenantId);
  if (cap && action !== 'pause') {
    const { campaigns, adsets } = await workspaceBudgets(tenantId);
    const base = { [entity.external_id]: { status: oldValue.status, daily_budget_paise: oldValue.daily_budget_paise } };
    const before = dailyBudgetTotal(campaigns, adsets, base);
    const after = dailyBudgetTotal(campaigns, adsets, { [entity.external_id]: { ...base[entity.external_id], ...change } });
    if (after > cap && after > before) {
      throw fail(422, `This would raise your total daily ad budget to ${rupees(after)}, above your cap of ${rupees(cap)}. Lower another budget or raise the cap in Ads Manager settings.`);
    }
  }

  const request = change.status ? { status: change.status } : { daily_budget: String(change.daily_budget_paise) };
  const base = { tenantId, userId, adAccountId: entity.ad_account_id, entityType, entityId: entity.external_id, entityName: current.name || entity.name, action, oldValue, request };
  let response;
  try {
    response = await graphRequest({ path: `/${entity.external_id}`, method: 'POST', token, gateKey, data: request, retries: 2 });
  } catch (e) {
    await audit({ query }, { ...base, success: false, error: String(e.message).slice(0, 500), response: { code: e.code ?? null } });
    throw fail(e.name === 'MetaGraphError' ? 400 : 502, `Facebook: ${e.message}`);
  }

  const after = snapshot(await graphRequest({ path: `/${entity.external_id}`, token, gateKey, params: { fields: def.fields } }).catch(() => ({ ...current, ...request })));
  await transaction(async (client) => {
    await client.query(
      `UPDATE ${def.table} SET status = $3, effective_status = $4, daily_budget_paise = $5, synced_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, entity.id, after.status, after.effective_status, after.daily_budget_paise]
    );
    if (entityType === 'campaign' && entity.crm_campaign_id) {
      await client.query(
        `UPDATE campaigns SET status = $3, daily_budget = COALESCE($4::numeric, daily_budget), budget = COALESCE($4::numeric, budget), updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, entity.crm_campaign_id, after.status === 'ACTIVE' ? 'active' : 'paused', after.daily_budget_paise != null ? after.daily_budget_paise / 100 : null]
      );
    }
    await audit(client, { ...base, newValue: after, response, success: true });
  });
  return { old_value: oldValue, new_value: after };
};

module.exports = { changeEntity, dailyBudgetTotal, workspaceBudgets, budgetCap };
