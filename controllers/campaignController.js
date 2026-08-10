const { query } = require('../config/db');
const { rankCampaigns } = require('../utils/campaignInsights');

// Lightweight, unfiltered/unpaginated metrics for every campaign in the tenant —
// used only as the baseline other campaigns get compared against for verdicts.
const getBaselineMetrics = async (tenantId) => {
  const result = await query(
    `SELECT c.id,
            (SELECT COUNT(*) FROM leads WHERE campaign_id = c.id) as total_leads,
            (SELECT COUNT(*) FROM leads WHERE campaign_id = c.id
               AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = c.tenant_id AND is_won = true)) as won_leads,
            (SELECT COUNT(*) FROM leads WHERE campaign_id = c.id
               AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = c.tenant_id AND is_lost = true)) as lost_leads,
            (SELECT COUNT(*) FROM leads WHERE campaign_id = c.id AND lead_score = 'hot') as hot_leads
     FROM campaigns c WHERE c.tenant_id = $1`,
    [tenantId]
  );
  return result.rows.map(c => {
    const totalLeads = parseInt(c.total_leads) || 0;
    const wonLeads = parseInt(c.won_leads) || 0;
    const lostLeads = parseInt(c.lost_leads) || 0;
    const hotLeads = parseInt(c.hot_leads) || 0;
    return {
      id: c.id,
      total_leads: totalLeads,
      conversion_rate: totalLeads > 0 ? ((wonLeads / totalLeads) * 100).toFixed(1) : 0,
      disqualified_rate: totalLeads > 0 ? ((lostLeads / totalLeads) * 100).toFixed(1) : 0,
      hot_rate: totalLeads > 0 ? ((hotLeads / totalLeads) * 100).toFixed(1) : 0,
    };
  });
};

// GET /api/campaigns - List all campaigns with metrics
const getCampaigns = async (req, res) => {
  try {
    const { status, source, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE c.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    if (status) { where += ` AND c.status = $${i++}`; params.push(status); }
    if (source) { where += ` AND c.source = $${i++}`; params.push(source); }
    if (search) { where += ` AND c.name ILIKE $${i++}`; params.push(`%${search}%`); }

    const result = await query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM leads WHERE campaign_id = c.id) as total_leads,
              (SELECT COUNT(*) FROM leads WHERE campaign_id = c.id
                 AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = c.tenant_id AND is_won = true)) as won_leads,
              (SELECT COUNT(*) FROM leads WHERE campaign_id = c.id
                 AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = c.tenant_id AND is_lost = true)) as lost_leads,
              (SELECT COUNT(*) FROM leads WHERE campaign_id = c.id AND lead_score = 'hot') as hot_leads,
              (SELECT COALESCE(SUM(deal_value), 0) FROM leads WHERE campaign_id = c.id
                 AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = c.tenant_id AND is_won = true)) as revenue,
              u.name as created_by_name
       FROM campaigns c
       LEFT JOIN users u ON c.created_by = u.id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      [...params, limit, offset]
    );

    // Calculate CPL, quality mix & ROI for each campaign
    const campaigns = result.rows.map(c => {
      const totalLeads = parseInt(c.total_leads) || 0;
      const wonLeads = parseInt(c.won_leads) || 0;
      const lostLeads = parseInt(c.lost_leads) || 0;
      const hotLeads = parseInt(c.hot_leads) || 0;
      const spend = parseFloat(c.actual_spend) || 0;
      const revenue = parseFloat(c.revenue) || 0;
      return {
        ...c,
        total_leads: totalLeads,
        won_leads: wonLeads,
        lost_leads: lostLeads,
        hot_leads: hotLeads,
        cpl: totalLeads > 0 ? (spend / totalLeads).toFixed(2) : 0,
        cost_per_won: wonLeads > 0 ? (spend / wonLeads).toFixed(2) : 0,
        conversion_rate: totalLeads > 0 ? ((wonLeads / totalLeads) * 100).toFixed(1) : 0,
        disqualified_rate: totalLeads > 0 ? ((lostLeads / totalLeads) * 100).toFixed(1) : 0,
        hot_rate: totalLeads > 0 ? ((hotLeads / totalLeads) * 100).toFixed(1) : 0,
        roi: spend > 0 ? (((revenue - spend) / spend) * 100).toFixed(1) : 0,
      };
    });

    const baseline = await getBaselineMetrics(req.tenantId);
    res.json({ campaigns: rankCampaigns(campaigns, baseline) });
  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
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
       FROM leads WHERE campaign_id = $1 AND tenant_id = $2 GROUP BY stage`,
      [req.params.id, req.tenantId]
    );

    // Leads list — filterable by stage/score/search, unlike the KPIs above
    // (which always reflect the whole campaign regardless of the list filter)
    const { stage, lead_score, search } = req.query;
    let leadsWhere = 'WHERE campaign_id = $1 AND tenant_id = $2';
    const leadsParams = [req.params.id, req.tenantId];
    let li = 3;
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
         FROM leads WHERE campaign_id = $1 AND tenant_id = $2
           AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $2 AND is_won = true)`,
        [req.params.id, req.tenantId]
      ),
      query(
        `SELECT COUNT(*) as lost_leads
         FROM leads WHERE campaign_id = $1 AND tenant_id = $2
           AND LOWER(stage) IN (SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $2 AND is_lost = true)`,
        [req.params.id, req.tenantId]
      ),
      query(`SELECT COUNT(*) as hot_leads FROM leads WHERE campaign_id = $1 AND tenant_id = $2 AND lead_score = 'hot'`,
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

    const baseline = await getBaselineMetrics(req.tenantId);

    res.json({
      campaign: rankCampaigns([campaignMetrics], baseline)[0],
      stageBreakdown: stageBreakdown.rows,
      recentLeads: recentLeads.rows,
    });
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/campaigns/:id/ads - Ad-level spend/performance within a campaign
const getCampaignAds = async (req, res) => {
  try {
    const owned = await query('SELECT id FROM campaigns WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!owned.rows.length) return res.status(404).json({ error: 'Campaign not found.' });

    const result = await query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM leads WHERE meta_ad_id = a.meta_ad_id AND tenant_id = a.tenant_id) as total_leads,
              (SELECT COUNT(*) FROM leads WHERE meta_ad_id = a.meta_ad_id AND tenant_id = a.tenant_id
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

    res.json({ ads });
  } catch (error) {
    console.error('Get campaign ads error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/campaigns
const createCampaign = async (req, res) => {
  try {
    const { name, source, description, budget, start_date, end_date, utm_source, utm_medium, utm_campaign } = req.body;
    if (!name || !source) return res.status(400).json({ error: 'Name and source required.' });

    const result = await query(
      `INSERT INTO campaigns (tenant_id, name, source, description, budget, start_date, end_date,
                              utm_source, utm_medium, utm_campaign, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.tenantId, name, source, description, budget || 0, start_date, end_date,
       utm_source, utm_medium, utm_campaign, req.user.id]
    );

    res.status(201).json({ campaign: result.rows[0] });
  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// PUT /api/campaigns/:id
const updateCampaign = async (req, res) => {
  try {
    const allowedFields = [
      'name', 'source', 'description', 'budget', 'actual_spend',
      'start_date', 'end_date', 'status', 'utm_source', 'utm_medium', 'utm_campaign',
    ];

    const updates = [];
    const params = [req.params.id, req.tenantId];
    let i = 3;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${i++}`);
        params.push(req.body[field]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    updates.push('updated_at = NOW()');

    const result = await query(
      `UPDATE campaigns SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Campaign not found.' });

    res.json({ campaign: result.rows[0] });
  } catch (error) {
    console.error('Update campaign error:', error);
    res.status(500).json({ error: 'Failed.' });
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
    res.status(500).json({ error: 'Failed.' });
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
       FROM leads WHERE campaign_id IS NOT NULL AND tenant_id = $1`,
      [req.tenantId]
    );

    res.json({ stats: { ...result.rows[0], ...leadStats.rows[0] } });
  } catch (error) {
    console.error('Campaign stats error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

module.exports = { getCampaigns, getCampaign, getCampaignAds, createCampaign, updateCampaign, deleteCampaign, getCampaignStats };
