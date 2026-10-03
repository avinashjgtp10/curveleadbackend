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

    const scope = await metricScope(req);
    const metrics = await getMetrics(scope);
    const breakdown = await getBreakdown(scope, 'campaign_id');
    const byId = new Map(breakdown.map(m => [m.campaign_id, m]));
    const lifetime = await getBreakdown({ ...scope, from: new Date(0), to: new Date() }, 'campaign_id');
    const lifetimeById = new Map(lifetime.map(m => [m.campaign_id,m]));
    const periodSpend = await periodMetaSpend(req.tenantId, scope, campaigns.map(c => c.id));
    const periodCampaigns = campaigns.map(c => {
      const m = byId.get(c.id) || { total_leads: 0, won: 0, lost: 0, hot_leads: 0, revenue: 0, conversion_rate: 0 };
      const spend = Number(c.actual_spend) || 0;
      const all = lifetimeById.get(c.id) || { total_leads: 0, won: 0, revenue: 0 };
      // Meta campaigns synced by Ads Manager: CPL = spend in the period ÷ CRM leads in the
      // period (same formula as Ads Manager). Others: lifetime spend ÷ lifetime leads.
      const ps = periodSpend.get(c.id);
      const cpl = ps !== undefined
        ? (m.total_leads ? (ps / m.total_leads).toFixed(2) : 0)
        : (all.total_leads ? (spend / all.total_leads).toFixed(2) : 0);
      return { ...c, ...m, id: c.id, won_leads: m.won, lost_leads: m.lost,
        cpl, cpl_basis: ps !== undefined ? 'period' : 'lifetime', period_spend: ps ?? null,
        cost_per_won: all.won ? (spend / all.won).toFixed(2) : 0,
        disqualified_rate: m.total_leads ? (m.lost / m.total_leads * 100).toFixed(1) : 0,
        hot_rate: m.total_leads ? (m.hot_leads / m.total_leads * 100).toFixed(1) : 0,
        roi: spend ? ((all.revenue-spend)/spend*100).toFixed(1) : 0 };

    });
    const counts = await query(`SELECT count(*)::int AS total FROM campaigns c ${where}`, params);
    res.json({ campaigns: rankCampaigns(periodCampaigns, breakdown.map(m => ({ ...m, id: m.campaign_id, disqualified_rate: m.total_leads ? m.lost/m.total_leads*100 : 0, hot_rate: m.total_leads ? m.hot_leads/m.total_leads*100 : 0 }))), metrics, total: counts.rows[0].total });
  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed.' });
  }
};

// Ads Manager spend per CRM campaign within the metrics period (workspace timezone days).
// Empty when the workspace doesn't use Ads Manager (or before its migration).
const periodMetaSpend = async (tenantId, scope, campaignIds) => {
  if (!campaignIds.length) return new Map();
  const tz = (await query("SELECT settings->>'timezone' AS tz FROM tenants WHERE id = $1", [tenantId])).rows[0]?.tz || 'Asia/Kolkata';
  const day = d => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const r = await query(
    `SELECT ac.campaign_id, COALESCE(sum(i.spend), 0)::float AS spend
     FROM ad_campaigns ac
     LEFT JOIN ad_insights_daily i ON i.tenant_id = ac.tenant_id AND i.entity_type = 'campaign' AND i.entity_id = ac.external_id
       AND i.date BETWEEN $3::date AND $4::date
     WHERE ac.tenant_id = $1 AND ac.campaign_id = ANY($2::uuid[])
     GROUP BY ac.campaign_id`,
    [tenantId, campaignIds, day(scope.from), day(new Date(scope.to.getTime() - 1))]
  ).catch(e => { if (e.code === '42P01') return { rows: [] }; throw e; });
  return new Map(r.rows.map(x => [x.campaign_id, x.spend]));
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

    // Get leads in this campaign grouped by stage
    const stageBreakdown = await query(
      `SELECT stage, COUNT(*) as count, COALESCE(SUM(deal_value), 0) as total_value
       FROM leads WHERE campaign_id = $1 AND tenant_id = $2 AND merged_into_id IS NULL GROUP BY stage`,
      [req.params.id, req.tenantId]
    );

    // Leads list — filterable by stage/score/search, unlike the KPIs above
    // (which always reflect the whole campaign regardless of the list filter)
    const { stage, lead_score, search } = req.query;
    let leadsWhere = 'WHERE campaign_id = $1 AND tenant_id = $2';
    const leadsParams = [req.params.id, req.tenantId];
    let li = 3;
    // Staff can only see (and open) their own assigned leads — same restriction
    // getLead enforces, so nothing shows up here that 404s when clicked.
    if (req.user.role === 'staff') { leadsWhere += ` AND assigned_to = $${li++}`; leadsParams.push(req.user.id); }
    if (stage) { leadsWhere += ` AND LOWER(stage) = LOWER($${li++})`; leadsParams.push(stage); }
    if (lead_score) { leadsWhere += ` AND lead_score = $${li++}`; leadsParams.push(lead_score); }
    if (search) { leadsWhere += ` AND (name ILIKE $${li} OR phone ILIKE $${li})`; leadsParams.push(`%${search}%`); li++; }

    const recentLeads = await query(
      `SELECT id, name, phone, email, stage, lead_score, created_at
       FROM leads ${leadsWhere}
       ORDER BY created_at DESC LIMIT 100`,
      leadsParams
    );

    // Won/lost-ness is tenant-configurable (lead_stages.is_won/is_lost), not the literal string
    const [wonStats, lostStats, scoreStats] = await Promise.all([
      query(
        `SELECT COUNT(*) as won_leads, COALESCE(SUM(deal_value), 0) as revenue
         FROM leads WHERE campaign_id = $1 AND tenant_id = $2 AND merged_into_id IS NULL
           AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $2 AND is_won = true)`,
        [req.params.id, req.tenantId]
      ),
      query(
        `SELECT COUNT(*) as lost_leads
         FROM leads WHERE campaign_id = $1 AND tenant_id = $2 AND merged_into_id IS NULL
           AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $2 AND is_lost = true)`,
        [req.params.id, req.tenantId]
      ),
      query(`SELECT COUNT(*) as hot_leads FROM leads WHERE campaign_id = $1 AND tenant_id = $2 AND merged_into_id IS NULL AND lead_score = 'hot'`,
        [req.params.id, req.tenantId]),
    ]);

    const totalLeads = stageBreakdown.rows.reduce((sum, s) => sum + parseInt(s.count), 0);
    const wonLeads = parseInt(wonStats.rows[0].won_leads) || 0;
    const lostLeads = parseInt(lostStats.rows[0].lost_leads) || 0;
    const hotLeads = parseInt(scoreStats.rows[0].hot_leads) || 0;
    const revenue = parseFloat(wonStats.rows[0].revenue) || 0;
    const spend = parseFloat(result.rows[0].actual_spend) || 0;

    const campaignMetrics = {
      ...result.rows[0],
      total_leads: totalLeads,
      won_leads: wonLeads,
      lost_leads: lostLeads,
      hot_leads: hotLeads,
      revenue,
      cpl: totalLeads > 0 ? (spend / totalLeads).toFixed(2) : 0,
      cost_per_won: wonLeads > 0 ? (spend / wonLeads).toFixed(2) : 0,
      conversion_rate: totalLeads > 0 ? ((wonLeads / totalLeads) * 100).toFixed(1) : 0,
      disqualified_rate: totalLeads > 0 ? ((lostLeads / totalLeads) * 100).toFixed(1) : 0,
      hot_rate: totalLeads > 0 ? ((hotLeads / totalLeads) * 100).toFixed(1) : 0,
      roi: spend > 0 ? (((revenue - spend) / spend) * 100).toFixed(1) : 0,
    };

    // Baseline for the verdict: every campaign's lifetime numbers, shaped like the
    // campaign list's baseline (getBaselineMetrics was removed in the Phase 2 refactor).
    const lifetime = await getBreakdown(
      { workspaceId: req.tenantId, from: new Date(0), to: new Date(), staffId: req.user.role === 'staff' ? req.user.id : null },
      'campaign_id'
    );
    const baseline = lifetime.filter(m => m.campaign_id).map(m => ({
      ...m, id: m.campaign_id,
      disqualified_rate: m.total_leads ? m.lost / m.total_leads * 100 : 0,
      hot_rate: m.total_leads ? m.hot_leads / m.total_leads * 100 : 0,
    }));

    res.json({
      campaign: rankCampaigns([campaignMetrics], baseline)[0],
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
        COUNT(*) FILTER (WHERE stage = 'won') as won_from_campaigns,
        COALESCE(SUM(deal_value) FILTER (WHERE stage = 'won'), 0) as revenue_from_campaigns
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
