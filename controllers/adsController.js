const { query } = require('../config/db');
const queues = require('../jobs/queues');
const { exchangeForLongLived, inspectToken, saveToken, syncAccountsForToken } = require('../services/metaAds/client');
const metaLeads = require('../services/metaLeads');
const controls = require('../services/metaAds/controls');

// Ads module API (Phase 1: accounts, drill-down, daily insights, CPL dashboard).
// Every query is scoped to req.tenantId.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPES = ['account', 'campaign', 'adset', 'ad'];
const bad = (res, error, status = 422) => res.status(status).json({ error });
const fail = (label) => (e, res) => { console.error(`${label}:`, e.message); res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed.' }); };

// from/to as YYYY-MM-DD (inclusive); default last 30 days; at most 400 days.
const dateRange = (q) => {
  const to = q.to || new Date().toISOString().slice(0, 10);
  const from = q.from || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw Object.assign(new Error('from and to must be YYYY-MM-DD with from ≤ to.'), { status: 422 });
  if ((new Date(to) - new Date(from)) / 864e5 > 400) throw Object.assign(new Error('Date range can be at most 400 days.'), { status: 422 });
  return { from, to };
};

// The requested ad account, or the tenant's primary one.
const resolveAccountId = async (tenantId, accountId) => {
  if (accountId && !UUID.test(accountId)) throw Object.assign(new Error('Invalid account_id.'), { status: 422 });
  const { rows } = await query(
    `SELECT id FROM ad_accounts WHERE tenant_id = $1 AND provider = 'meta' AND ($2::uuid IS NULL OR id = $2::uuid)
     ORDER BY is_primary DESC, created_at LIMIT 1`,
    [tenantId, accountId || null]
  );
  if (!rows[0]) throw Object.assign(new Error(accountId ? 'Ad account not found.' : 'Connect a Meta ad account first.'), { status: 404 });
  return rows[0].id;
};

const totals = `COALESCE(sum(i.spend), 0)::float AS spend, COALESCE(sum(i.impressions), 0)::bigint AS impressions,
  COALESCE(sum(i.clicks), 0)::bigint AS clicks, COALESCE(sum(i.leads), 0)::int AS leads,
  CASE WHEN sum(i.impressions) > 0 THEN round(sum(i.clicks)::numeric * 100 / sum(i.impressions), 2)::float END AS ctr,
  CASE WHEN sum(i.clicks) > 0 THEN round(sum(i.spend) / sum(i.clicks), 2)::float END AS cpc,
  CASE WHEN sum(i.leads) > 0 THEN round(sum(i.spend) / sum(i.leads), 2)::float END AS cpl`;

// GET /api/ads/accounts
const listAccounts = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT a.id, a.external_id, a.name, a.currency, a.timezone_name, a.account_status, a.is_primary, a.is_active,
              a.last_synced_at, a.insights_synced_through, a.sync_error,
              t.status AS token_status, t.expires_at AS token_expires_at
       FROM ad_accounts a LEFT JOIN ad_oauth_tokens t ON t.id = a.token_id AND t.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1 AND a.provider = 'meta' ORDER BY a.is_primary DESC, a.name`,
      [req.tenantId]
    );
    res.json({ accounts: rows });
  } catch (e) { fail('List ad accounts')(e, res); }
};

// POST /api/ads/accounts/connect { user_token } — token from Facebook Login.
const connectAccounts = async (req, res) => {
  try {
    const { user_token } = req.body || {};
    if (typeof user_token !== 'string' || user_token.length < 20) return bad(res, 'user_token required.');
    const token = await exchangeForLongLived(user_token);
    const info = await inspectToken(token);
    if (!info.is_valid || !info.user_id) return bad(res, 'Facebook did not return a valid token. Please try again.', 400);
    if (!info.scopes.some((s) => s === 'ads_read' || s === 'ads_management'))
      return bad(res, 'Grant the "ads_read" permission when logging in with Facebook to connect ad accounts.', 400);
    const tokenId = await saveToken({ tenantId: req.tenantId, userId: req.user.id, externalUserId: info.user_id, token, scopes: info.scopes, expiresAt: info.expires_at });
    const count = await syncAccountsForToken({ tenantId: req.tenantId, tokenId, token });
    const { rows } = await query("SELECT id FROM ad_accounts WHERE tenant_id = $1 AND token_id = $2 AND is_active", [req.tenantId, tokenId]);
    for (const a of rows) await queues.enqueue('ads:sync-account', { tenantId: req.tenantId, adAccountId: a.id }, { jobId: `sync-${a.id}` });
    res.json({ connected: count });
  } catch (e) {
    if (e.name === 'MetaGraphError') return bad(res, `Facebook: ${e.message}`, 400);
    fail('Connect ad accounts')(e, res);
  }
};

// POST /api/ads/accounts/:id/primary
const setPrimary = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const { rows } = await query('SELECT id FROM ad_accounts WHERE tenant_id = $1 AND id = $2', [req.tenantId, req.params.id]);
    if (!rows[0]) return bad(res, 'Ad account not found.', 404);
    await query(`UPDATE ad_accounts SET is_primary = (id = $2), updated_at = now() WHERE tenant_id = $1 AND provider = 'meta' AND (is_primary OR id = $2)`, [req.tenantId, req.params.id]);
    res.json({ primary: req.params.id });
  } catch (e) { fail('Set primary ad account')(e, res); }
};

// POST /api/ads/accounts/:id/sync — queue a sync now.
const syncNow = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const { rows } = await query('SELECT id FROM ad_accounts WHERE tenant_id = $1 AND id = $2 AND is_active', [req.tenantId, req.params.id]);
    if (!rows[0]) return bad(res, 'Ad account not found.', 404);
    await queues.enqueue('ads:sync-account', { tenantId: req.tenantId, adAccountId: rows[0].id }, { jobId: `sync-${rows[0].id}` });
    res.status(202).json({ queued: true });
  } catch (e) { fail('Queue ad sync')(e, res); }
};

// GET /api/ads/campaigns?account_id&from&to
const listCampaigns = async (req, res) => {
  try {
    const { from, to } = dateRange(req.query);
    const accountId = await resolveAccountId(req.tenantId, req.query.account_id);
    const { rows } = await query(
      `SELECT c.id, c.external_id, c.campaign_id AS crm_campaign_id, c.name, c.objective, c.status, c.effective_status,
              c.daily_budget_paise, c.lifetime_budget_paise, c.special_ad_categories, c.start_time, c.stop_time, ${totals}
       FROM ad_campaigns c
       LEFT JOIN ad_insights_daily i ON i.tenant_id = c.tenant_id AND i.entity_type = 'campaign' AND i.entity_id = c.external_id AND i.date BETWEEN $3 AND $4
       WHERE c.tenant_id = $1 AND c.ad_account_id = $2
       GROUP BY c.id ORDER BY spend DESC, c.name`,
      [req.tenantId, accountId, from, to]
    );
    res.json({ account_id: accountId, from, to, campaigns: rows });
  } catch (e) { fail('List ad campaigns')(e, res); }
};

// GET /api/ads/campaigns/:id/adsets?from&to
const listAdsets = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const { from, to } = dateRange(req.query);
    const parent = await query('SELECT id, name, external_id FROM ad_campaigns WHERE tenant_id = $1 AND id = $2', [req.tenantId, req.params.id]);
    if (!parent.rows[0]) return bad(res, 'Campaign not found.', 404);
    const { rows } = await query(
      `SELECT s.id, s.external_id, s.name, s.status, s.effective_status, s.daily_budget_paise, s.lifetime_budget_paise,
              s.optimization_goal, s.billing_event, ${totals}
       FROM ad_adsets s
       LEFT JOIN ad_insights_daily i ON i.tenant_id = s.tenant_id AND i.entity_type = 'adset' AND i.entity_id = s.external_id AND i.date BETWEEN $3 AND $4
       WHERE s.tenant_id = $1 AND s.ad_campaign_id = $2
       GROUP BY s.id ORDER BY spend DESC, s.name`,
      [req.tenantId, req.params.id, from, to]
    );
    res.json({ campaign: parent.rows[0], from, to, adsets: rows });
  } catch (e) { fail('List ad sets')(e, res); }
};

// GET /api/ads/adsets/:id/ads?from&to
const listAds = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const { from, to } = dateRange(req.query);
    const parent = await query('SELECT id, name, external_id, ad_campaign_id FROM ad_adsets WHERE tenant_id = $1 AND id = $2', [req.tenantId, req.params.id]);
    if (!parent.rows[0]) return bad(res, 'Ad set not found.', 404);
    const { rows } = await query(
      `SELECT a.id, a.external_id, a.name, a.status, a.effective_status, a.creative, ${totals}
       FROM ad_ads a
       LEFT JOIN ad_insights_daily i ON i.tenant_id = a.tenant_id AND i.entity_type = 'ad' AND i.entity_id = a.external_id AND i.date BETWEEN $3 AND $4
       WHERE a.tenant_id = $1 AND a.ad_adset_id = $2
       GROUP BY a.id ORDER BY spend DESC, a.name`,
      [req.tenantId, req.params.id, from, to]
    );
    res.json({ adset: parent.rows[0], from, to, ads: rows });
  } catch (e) { fail('List ads')(e, res); }
};

// GET /api/ads/insights/daily?entity_type&entity_id&from&to — chart series (entity_id = Meta id).
const dailyInsights = async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!ENTITY_TYPES.includes(entity_type)) return bad(res, `entity_type must be one of: ${ENTITY_TYPES.join(', ')}.`);
    if (typeof entity_id !== 'string' || !/^(act_)?\d{1,30}$/.test(entity_id)) return bad(res, 'Invalid entity_id.');
    const { from, to } = dateRange(req.query);
    const { rows } = await query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, spend::float, impressions, clicks, ctr::float, cpc::float, leads, cpl::float
       FROM ad_insights_daily WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 AND date BETWEEN $4 AND $5 ORDER BY date`,
      [req.tenantId, entity_type, entity_id, from, to]
    );
    res.json({ entity_type, entity_id, from, to, days: rows });
  } catch (e) { fail('Daily insights')(e, res); }
};

// GET /api/ads/dashboard?account_id&from&to
// Per campaign: Meta's CPL vs cost per qualified lead vs cost per converted lead.
// CRM side = leads attributed to the campaign and created in the range;
// "qualified" = reached an is_qualified or won stage, "converted" = reached a won stage
// (current stage or stage history).
const dashboard = async (req, res) => {
  try {
    const { from, to } = dateRange(req.query);
    const accountId = await resolveAccountId(req.tenantId, req.query.account_id);
    const { rows } = await query(
      `WITH spend AS (
         SELECT entity_id, sum(spend) AS spend, sum(leads) AS meta_leads
         FROM ad_insights_daily WHERE tenant_id = $1 AND ad_account_id = $2 AND entity_type = 'campaign' AND date BETWEEN $3 AND $4
         GROUP BY entity_id
       ), crm AS (
         SELECT ac.external_id, count(*) AS crm_leads,
                count(*) FILTER (WHERE f.qualified) AS qualified, count(*) FILTER (WHERE f.converted) AS converted
         FROM ad_campaigns ac
         JOIN leads l ON l.tenant_id = ac.tenant_id AND l.campaign_id = ac.campaign_id
         CROSS JOIN LATERAL (
           SELECT bool_or(s.is_qualified OR COALESCE(s.is_won, false)) AS qualified, bool_or(COALESCE(s.is_won, false)) AS converted
           FROM lead_stages s
           WHERE s.tenant_id = l.tenant_id AND (
             lower(trim(s.name)) = lower(trim(l.stage))
             OR EXISTS (SELECT 1 FROM lead_stage_history h WHERE h.tenant_id = l.tenant_id AND h.lead_id = l.id AND lower(trim(h.new_stage)) = lower(trim(s.name))))
         ) f
         WHERE ac.tenant_id = $1 AND ac.ad_account_id = $2 AND l.created_at >= $3::date AND l.created_at < $4::date + 1
         GROUP BY ac.external_id
       )
       SELECT ac.id, ac.external_id, ac.campaign_id AS crm_campaign_id, ac.name, ac.effective_status,
              COALESCE(sp.spend, 0)::float AS spend, COALESCE(sp.meta_leads, 0)::int AS meta_leads,
              CASE WHEN sp.meta_leads > 0 THEN round(sp.spend / sp.meta_leads, 2)::float END AS meta_cpl,
              COALESCE(c.crm_leads, 0)::int AS crm_leads,
              COALESCE(c.qualified, 0)::int AS qualified_leads,
              CASE WHEN c.qualified > 0 THEN round(sp.spend / c.qualified, 2)::float END AS cost_per_qualified,
              COALESCE(c.converted, 0)::int AS converted_leads,
              CASE WHEN c.converted > 0 THEN round(sp.spend / c.converted, 2)::float END AS cost_per_converted
       FROM ad_campaigns ac
       LEFT JOIN spend sp ON sp.entity_id = ac.external_id
       LEFT JOIN crm c ON c.external_id = ac.external_id
       WHERE ac.tenant_id = $1 AND ac.ad_account_id = $2 AND (sp.spend > 0 OR c.crm_leads > 0)
       ORDER BY spend DESC`,
      [req.tenantId, accountId, from, to]
    );
    const sum = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const div = (a, b) => (b > 0 ? Number((a / b).toFixed(2)) : null);
    const spend = sum('spend');
    res.json({
      account_id: accountId, from, to, campaigns: rows,
      totals: {
        spend: Number(spend.toFixed(2)), meta_leads: sum('meta_leads'), meta_cpl: div(spend, sum('meta_leads')),
        crm_leads: sum('crm_leads'), qualified_leads: sum('qualified_leads'), cost_per_qualified: div(spend, sum('qualified_leads')),
        converted_leads: sum('converted_leads'), cost_per_converted: div(spend, sum('converted_leads')),
      },
    });
  } catch (e) { fail('Ads dashboard')(e, res); }
};

// GET /api/ads/forms — lead forms on the connected Facebook Page (refreshed from Meta).
const listLeadForms = async (req, res) => {
  try { res.json(await metaLeads.listForms(req.tenantId)); }
  catch (e) {
    if (e.code === 'NO_PAGE') return bad(res, 'Connect your Facebook Page in Integrations to see its lead forms.', 400);
    if (e.name === 'MetaGraphError') return bad(res, `Facebook: ${e.message}`, 400);
    fail('List lead forms')(e, res);
  }
};

// POST /api/ads/forms/:id/backfill { since?: 'YYYY-MM-DD' } — import every lead of a form.
// Leads already in the CRM are skipped; old leads are not messaged.
const backfillLeadForm = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const since = req.body?.since || null;
    if (since && !DATE.test(since)) return bad(res, 'since must be YYYY-MM-DD.');
    const { rows } = await query('SELECT id FROM ad_lead_forms WHERE tenant_id = $1 AND id = $2', [req.tenantId, req.params.id]);
    if (!rows[0]) return bad(res, 'Lead form not found.', 404);
    await queues.enqueue('leads:backfill-form', { tenantId: req.tenantId, formId: rows[0].id, since }, { jobId: `backfill-${rows[0].id}` });
    res.status(202).json({ queued: true });
  } catch (e) { fail('Queue lead form backfill')(e, res); }
};

// PUT /api/ads/lead-settings { score_on_ingest } — score new Meta leads as they arrive.
const updateLeadSettings = async (req, res) => {
  try {
    if (typeof req.body?.score_on_ingest !== 'boolean') return bad(res, 'score_on_ingest must be true or false.');
    await query(`UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('meta_lead_score_on_ingest', $2::boolean) WHERE id = $1`,
      [req.tenantId, req.body.score_on_ingest]);
    res.json({ score_on_ingest: req.body.score_on_ingest });
  } catch (e) { fail('Update lead settings')(e, res); }
};

// POST /api/ads/{campaigns|adsets}/:id/{pause|resume}, PATCH …/:id/budget { daily_budget_paise }
const changeEntity = (entityType, action) => async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid id.');
    const result = await controls.changeEntity({
      tenantId: req.tenantId, userId: req.user.id, entityType, id: req.params.id, action,
      dailyBudgetPaise: action === 'update_budget' ? Number(req.body?.daily_budget_paise) : undefined,
    });
    res.json(result);
  } catch (e) { fail(`${action} ${entityType}`)(e, res); }
};

// GET /api/ads/audit?entity_type&entity_id&limit — newest first.
const listAudit = async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (entity_type && !['campaign', 'adset', 'ad'].includes(entity_type)) return bad(res, 'Invalid entity_type.');
    if (entity_id && !/^\d{1,30}$/.test(entity_id)) return bad(res, 'Invalid entity_id.');
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { rows } = await query(
      `SELECT a.id, a.entity_type, a.entity_id, a.entity_name, a.action, a.old_value, a.new_value, a.success, a.error, a.created_at, u.name AS user_name
       FROM ad_audit_log a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.tenant_id = $1 AND ($2::text IS NULL OR a.entity_type = $2) AND ($3::text IS NULL OR a.entity_id = $3)
       ORDER BY a.created_at DESC LIMIT $4`,
      [req.tenantId, entity_type || null, entity_id || null, limit]
    );
    res.json({ entries: rows });
  } catch (e) { fail('List ad audit log')(e, res); }
};

// GET /api/ads/settings — daily budget cap and what's currently set to spend per day.
const getAdsSettings = async (req, res) => {
  try {
    const { campaigns, adsets } = await controls.workspaceBudgets(req.tenantId);
    res.json({ daily_budget_cap_paise: await controls.budgetCap(req.tenantId), active_daily_budget_paise: controls.dailyBudgetTotal(campaigns, adsets) });
  } catch (e) { fail('Get ads settings')(e, res); }
};

// PUT /api/ads/settings { daily_budget_cap_paise: int | null } — admins only.
const updateAdsSettings = async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'super_admin') return bad(res, 'Only admins can change the budget cap.', 403);
    const cap = req.body?.daily_budget_cap_paise;
    if (cap !== null && (!Number.isInteger(cap) || cap < 100)) return bad(res, 'daily_budget_cap_paise must be a whole number of paise (at least 100) or null.');
    await query(
      cap === null
        ? `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) - 'ads_daily_budget_cap_paise' WHERE id = $1`
        : `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('ads_daily_budget_cap_paise', $2::bigint) WHERE id = $1`,
      cap === null ? [req.tenantId] : [req.tenantId, cap]
    );
    res.json({ daily_budget_cap_paise: cap });
  } catch (e) { fail('Update ads settings')(e, res); }
};

// GET /api/ads/capi/events — Conversions API setup state + the latest queued events.
const listCapiEvents = async (req, res) => {
  try {
    const t = (await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId])).rows[0]?.settings || {};
    const { rows } = await query(
      `SELECT q.id, q.event_name, q.status, q.attempts, q.last_error, q.created_at, q.sent_at, l.id AS lead_id, l.name AS lead_name, l.stage
       FROM meta_capi_queue q LEFT JOIN leads l ON l.id = q.lead_id AND l.tenant_id = q.tenant_id
       WHERE q.tenant_id = $1 ORDER BY q.created_at DESC LIMIT 50`, [req.tenantId]
    );
    res.json({
      enabled: !!t.meta_capi_enabled,
      configured: !!(t.meta_dataset_id && t.meta_capi_access_token),
      qualified_event: t.meta_qualified_event || 'QualifiedLead',
      converted_event: t.meta_won_event || 'ConvertedLead',
      events: rows,
    });
  } catch (e) { fail('List CAPI events')(e, res); }
};

module.exports = {
  listCapiEvents,
  pauseCampaign: changeEntity('campaign', 'pause'), resumeCampaign: changeEntity('campaign', 'resume'), updateCampaignBudget: changeEntity('campaign', 'update_budget'),
  pauseAdset: changeEntity('adset', 'pause'), resumeAdset: changeEntity('adset', 'resume'), updateAdsetBudget: changeEntity('adset', 'update_budget'),
  listAudit, getAdsSettings, updateAdsSettings,
  listLeadForms, backfillLeadForm, updateLeadSettings, listAccounts, connectAccounts, setPrimary, syncNow, listCampaigns, listAdsets, listAds, dailyInsights, dashboard, dateRange };
