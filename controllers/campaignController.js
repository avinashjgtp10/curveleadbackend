const { normalizeSource } = require('../utils/dataQuality');
const { metricScope, getMetrics, getBreakdown } = require('../services/metrics');
const { query } = require('../config/db');
const { rankCampaigns } = require('../utils/campaignInsights');

// GET /api/campaigns - List all campaigns with metrics
const getCampaigns = async (req, res) => {
  try {
    const { status, source, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let where = 'WHERE c.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    if (status) { where += ` AND c.status = $${i++}`; params.push(status); }
    if (source) { where += ` AND c.source = $${i++}`; params.push(source); }
    if (search) { where += ` AND c.name ILIKE $${i++}`; params.push(`%${search}%`); }

    const result = await query(
      `SELECT c.*,
              u.name as created_by_name
       FROM campaigns c
       LEFT JOIN users u ON c.created_by = u.id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      [...params, limit, offset]
    );

    const campaigns = result.rows;
    const counts = await query(`SELECT count(*)::int AS total FROM campaigns c ${where}`, params);
    const { totals, rows } = await campaignRows(req, campaigns);
    res.json({ campaigns: rows, metrics: totals, total: counts.rows[0].total });
  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed.' });
  }
};

// Campaign rows for the selected range from the shared metrics (services/metrics.js), plus
// the verdicts. KPIs (`totals`) count campaign-attributed leads only; the verdict baseline is
// the same weighted rate the KPIs show. lifetime_spend = the campaign's running total.
const EMPTY = { crm_leads: 0, total_leads: 0, won: 0, converted: 0, qualified: 0, lost: 0, hot_leads: 0, unassigned: 0, revenue: 0,
  conversion_rate: 0, spend: null, currency: null, spend_basis: 'not_measured', platform_leads: null, cpl: null, cost_per_customer: null, platform_cpl: null };
const rates = (m) => ({
  disqualified_rate: m.crm_leads ? Number((m.lost / m.crm_leads * 100).toFixed(1)) : 0,
  hot_rate: m.crm_leads ? Number((m.hot_leads / m.crm_leads * 100).toFixed(1)) : 0,
});
const campaignRows = async (req, campaigns) => {
  const scope = await metricScope(req);
  const [totals, breakdown] = await Promise.all([getMetrics(scope, { attributedOnly: true }), getBreakdown(scope, 'campaign_id')]);
  const byId = new Map(breakdown.map(m => [m.campaign_id, m]));
  const rows = campaigns.map(c => {
    const m = { ...EMPTY, ...(byId.get(c.id) || {}) };
    return { ...c, ...m, ...rates(m), id: c.id, lifetime_spend: Number(c.actual_spend) || 0, won_leads: m.won, lost_leads: m.lost,
      roi: m.spend ? Number((((m.revenue - m.spend) / m.spend) * 100).toFixed(1)) : null };
  });
  const r = rates(totals);
  const avg = { conversion: totals.conversion_rate, disqualified: r.disqualified_rate, hot: r.hot_rate };
  const baseline = breakdown.filter(m => m.campaign_id).map(m => ({ ...m, ...rates(m), id: m.campaign_id }));
  return { totals, rows: rankCampaigns(rows, baseline, { avg }), scope };
};

// GET /api/campaigns/:id - Campaign details with lead breakdown
const getCampaign = async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*, u.name as created_by_name FROM campaigns c
       LEFT JOIN users u ON c.created_by = u.id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' });

    // Everything below uses the same date range (and definitions) as the Campaigns tab;
    // period=lifetime shows the whole campaign.
    const scope = await metricScope(req);
    const range = [scope.from, scope.to];
    const isStaff = req.user.role === 'staff';

    const stageBreakdown = await query(
      `SELECT stage, COUNT(*) as count, COALESCE(SUM(deal_value), 0) as total_value
       FROM leads WHERE campaign_id = $1 AND tenant_id = $2 AND merged_into_id IS NULL AND created_at >= $3 AND created_at < $4
       ${isStaff ? 'AND assigned_to = $5' : ''} GROUP BY stage`,
      [req.params.id, req.tenantId, ...range, ...(isStaff ? [req.user.id] : [])]
    );

    // Leads list — filterable by stage/score/search within the range.
    const { stage, lead_score, search } = req.query;
    let leadsWhere = 'WHERE campaign_id = $1 AND tenant_id = $2 AND merged_into_id IS NULL AND created_at >= $3 AND created_at < $4';
    const leadsParams = [req.params.id, req.tenantId, ...range];
    let li = 5;
    // Staff can only see (and open) their own assigned leads — same restriction
    // getLead enforces, so nothing shows up here that 404s when clicked.
    if (isStaff) { leadsWhere += ` AND assigned_to = $${li++}`; leadsParams.push(req.user.id); }
    if (stage) { leadsWhere += ` AND LOWER(stage) = LOWER($${li++})`; leadsParams.push(stage); }
    if (lead_score) { leadsWhere += ` AND lead_score = $${li++}`; leadsParams.push(lead_score); }
    if (search) { leadsWhere += ` AND (name ILIKE $${li} OR phone ILIKE $${li})`; leadsParams.push(`%${search}%`); li++; }

    const recentLeads = await query(
      `SELECT id, name, phone, email, stage, lead_score, created_at
       FROM leads ${leadsWhere}
       ORDER BY created_at DESC LIMIT 100`,
      leadsParams
    );

    const { rows } = await campaignRows(req, [result.rows[0]]);
    res.json({
      campaign: rows[0],
      range: { period: req.query.period || 'this_month', from: scope.from.toISOString(), to: scope.to.toISOString() },
      stageBreakdown: stageBreakdown.rows,
      recentLeads: recentLeads.rows,
    });
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed.' });
  }
};

// GET /api/campaigns/:id/ads - Ad-level spend/performance within a campaign
const getCampaignAds = async (req, res) => {
  try {
    const owned = await query('SELECT id FROM campaigns WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Campaign not found.' });

    // Ads module (Ads Manager) data: ads under this CRM campaign with spend summed over the
    // synced days. Falls back to the legacy meta_ads table for workspaces not migrated yet.
    const modern = await query(
      `SELECT ad.id, ad.external_id AS meta_ad_id, ad.name, ad.effective_status,
              COALESCE(sum(i.spend), 0)::float AS spend, COALESCE(sum(i.impressions), 0)::bigint AS impressions,
              COALESCE(sum(i.clicks), 0)::bigint AS clicks, COALESCE(sum(i.leads), 0)::int AS meta_leads,
              min(i.date) AS from_date,
              (SELECT COUNT(*) FROM leads WHERE meta_ad_id = ad.external_id AND tenant_id = ad.tenant_id AND merged_into_id IS NULL) AS total_leads,
              (SELECT COUNT(*) FROM leads WHERE meta_ad_id = ad.external_id AND tenant_id = ad.tenant_id AND merged_into_id IS NULL
                 AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = ad.tenant_id AND is_won = true)) AS won_leads
       FROM ad_campaigns ac
       JOIN ad_adsets s ON s.ad_campaign_id = ac.id AND s.tenant_id = ac.tenant_id
       JOIN ad_ads ad ON ad.ad_adset_id = s.id AND ad.tenant_id = ac.tenant_id
       LEFT JOIN ad_insights_daily i ON i.tenant_id = ad.tenant_id AND i.entity_type = 'ad' AND i.entity_id = ad.external_id
       WHERE ac.tenant_id = $2 AND ac.campaign_id = $1
       GROUP BY ad.id ORDER BY spend DESC, ad.name`,
      [req.params.id, req.tenantId]
    ).catch(e => { if (e.code === '42P01') return { rows: [] }; throw e; });

    const result = modern.rows.length ? modern : await query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM leads WHERE meta_ad_id = a.meta_ad_id AND tenant_id = a.tenant_id AND merged_into_id IS NULL) as total_leads,
              (SELECT COUNT(*) FROM leads WHERE meta_ad_id = a.meta_ad_id AND tenant_id = a.tenant_id AND merged_into_id IS NULL
                 AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = a.tenant_id AND is_won = true)) as won_leads
       FROM meta_ads a
       WHERE a.campaign_id = $1 AND a.tenant_id = $2
       ORDER BY a.spend DESC`,
      [req.params.id, req.tenantId]
    );

    const ads = result.rows.map(a => {
      const totalLeads = parseInt(a.total_leads) || 0;
      const spend = parseFloat(a.spend) || 0;
      return { ...a, total_leads: totalLeads, won_leads: parseInt(a.won_leads) || 0, cpl: totalLeads > 0 ? (spend / totalLeads).toFixed(2) : 0 };
    });

    res.json({ ads, source: modern.rows.length ? 'ads_manager' : 'legacy' });
  } catch (error) {
    console.error('Get campaign ads error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed.' });
  }
};

// POST /api/campaigns
const createCampaign = async (req, res) => {
  try {
    const { name, source, description, budget, start_date, end_date, utm_source, utm_medium, utm_campaign, is_priority } = req.body;
    if (!name || !source) return res.status(400).json({ error: 'Name and source required.' });

    const result = await query(
      `INSERT INTO campaigns (tenant_id, name, source, description, budget, start_date, end_date,
                              utm_source, utm_medium, utm_campaign, created_by, is_priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [req.tenantId, name, normalizeSource(source), description, budget || 0, start_date, end_date,
       utm_source, utm_medium, utm_campaign, req.user.id, is_priority || false]
    );

    res.status(201).json({ campaign: result.rows[0] });
  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed.' });
  }
};

// PUT /api/campaigns/:id
const updateCampaign = async (req, res) => {
  try {
    if (req.body.source !== undefined) req.body.source = normalizeSource(req.body.source);
    const allowedFields = [
      'name', 'source', 'description', 'budget', 'actual_spend',
      'start_date', 'end_date', 'status', 'utm_source', 'utm_medium', 'utm_campaign', 'is_priority',
    ];

    const current = await query('SELECT meta_campaign_id FROM campaigns WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' });
    // A Meta-synced campaign's status, budget, spend and dates come from Meta (the sync
    // overwrites them) — those are changed in Ads Manager → Meta Ads, not here.
    const metaManaged = current.rows[0].meta_campaign_id ? ['budget', 'actual_spend', 'start_date', 'end_date', 'status'] : [];
    const fields = allowedFields.filter(f => req.body[f] !== undefined && !metaManaged.includes(f));
    if (!fields.length && metaManaged.some(f => req.body[f] !== undefined)) {
      return res.status(409).json({ error: 'This campaign is managed in Meta. Change its status, budget or dates in Ads Manager → Meta Ads.' });
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    const params = [req.params.id, req.tenantId, ...fields.map(f => req.body[f])];
    const updates = [...fields.map((f, idx) => `${f} = $${idx + 3}`), 'updated_at = NOW()'];

    const result = await query(
      `UPDATE campaigns SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' });

    res.json({ campaign: result.rows[0] });
  } catch (error) {
    console.error('Update campaign error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed.' });
  }
};

// DELETE /api/campaigns/:id
const deleteCampaign = async (req, res) => {
  try {
    // First unlink leads (don't delete leads, just remove campaign reference)
    await query('UPDATE leads SET campaign_id = NULL WHERE campaign_id = $1', [req.params.id]);
    const result = await query('DELETE FROM campaigns WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' });
    res.json({ message: 'Campaign deleted.' });
  } catch (error) {
    console.error('Delete campaign error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed.' });
  }
};

// GET /api/campaigns/stats/summary - Overall campaign performance
const getCampaignStats = async (req, res) => {
  try {
    const result = await query(
      `SELECT 
        COUNT(*) as total_campaigns,
        COUNT(*) FILTER (WHERE status = 'active') as active_campaigns,
        COALESCE(SUM(budget), 0) as total_budget,
        COALESCE(SUM(actual_spend), 0) as total_spend
       FROM campaigns WHERE tenant_id = $1`,
      [req.tenantId]
    );

    const leadStats = await query(
      `SELECT 
        COUNT(*) as leads_from_campaigns,
        COUNT(*) FILTER (WHERE lower(trim(stage)) IN (SELECT lower(trim(s.name)) FROM lead_stages s WHERE s.tenant_id = leads.tenant_id AND s.is_won)) as won_from_campaigns,
        COALESCE(SUM(deal_value) FILTER (WHERE lower(trim(stage)) IN (SELECT lower(trim(s.name)) FROM lead_stages s WHERE s.tenant_id = leads.tenant_id AND s.is_won)), 0) as revenue_from_campaigns
       FROM leads WHERE campaign_id IS NOT NULL AND tenant_id = $1 AND merged_into_id IS NULL`,
      [req.tenantId]
    );

    res.json({ stats: { ...result.rows[0], ...leadStats.rows[0] } });
  } catch (error) {
    console.error('Campaign stats error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed.' });
  }
};

module.exports = { getCampaigns, getCampaign, getCampaignAds, createCampaign, updateCampaign, deleteCampaign, getCampaignStats };
