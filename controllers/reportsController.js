const { query } = require('../config/db');

// GET /api/reports/conversion - Overall conversion funnel
const getConversionReport = async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    let dateFilter = '';
    const params = [req.tenantId];

    if (date_from) {
      dateFilter += ` AND created_at >= $${params.length + 1}`;
      params.push(date_from);
    }
    if (date_to) {
      dateFilter += ` AND created_at <= $${params.length + 1}::date + INTERVAL '1 day'`;
      params.push(date_to);
    }

    // Stage breakdown
    const stages = await query(
      `SELECT stage, COUNT(*) as count, COALESCE(SUM(deal_value), 0) as value
       FROM leads WHERE tenant_id = $1 ${dateFilter}
       GROUP BY stage ORDER BY count DESC`,
      params
    );

    const total = stages.rows.reduce((sum, s) => sum + parseInt(s.count), 0);
    const won = stages.rows.find(s => s.stage === 'won')?.count || 0;
    const lost = stages.rows.find(s => s.stage === 'lost')?.count || 0;

    res.json({
      total_leads: total,
      won: parseInt(won),
      lost: parseInt(lost),
      conversion_rate: total > 0 ? ((won / total) * 100).toFixed(1) : 0,
      stages: stages.rows.map(s => ({
        ...s,
        count: parseInt(s.count),
        percentage: total > 0 ? ((s.count / total) * 100).toFixed(1) : 0,
      })),
    });
  } catch (error) {
    console.error('Conversion report error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/reports/by-source - Conversion by lead source
const getReportBySource = async (req, res) => {
  try {
    const result = await query(
      `SELECT source,
              COUNT(*) as total_leads,
              COUNT(*) FILTER (WHERE stage = 'won') as won,
              COUNT(*) FILTER (WHERE stage = 'lost') as lost,
              COALESCE(SUM(deal_value) FILTER (WHERE stage = 'won'), 0) as revenue
       FROM leads WHERE tenant_id = $1 GROUP BY source ORDER BY total_leads DESC`,
      [req.tenantId]
    );

    const sources = result.rows.map(s => ({
      ...s,
      total_leads: parseInt(s.total_leads),
      won: parseInt(s.won),
      lost: parseInt(s.lost),
      conversion_rate: s.total_leads > 0 ? ((s.won / s.total_leads) * 100).toFixed(1) : 0,
    }));

    res.json({ sources });
  } catch (error) {
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/reports/by-staff - Conversion by team member
const getReportByStaff = async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.email,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE l.stage = 'won') as won,
              COUNT(l.id) FILTER (WHERE l.stage = 'lost') as lost,
              COALESCE(SUM(l.deal_value) FILTER (WHERE l.stage = 'won'), 0) as revenue,
              (SELECT COUNT(*) FROM followups WHERE assigned_to = u.id AND completed = false) as pending_followups
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id AND l.tenant_id = u.tenant_id
       WHERE u.tenant_id = $1 AND u.is_active = true
       GROUP BY u.id, u.name, u.email
       ORDER BY revenue DESC`,
      [req.tenantId]
    );

    const staff = result.rows.map(s => ({
      ...s,
      total_leads: parseInt(s.total_leads),
      won: parseInt(s.won),
      lost: parseInt(s.lost),
      conversion_rate: s.total_leads > 0 ? ((s.won / s.total_leads) * 100).toFixed(1) : 0,
    }));

    res.json({ staff });
  } catch (error) {
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/reports/by-campaign - Campaign ROI
const getReportByCampaign = async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.name, c.source, c.budget, c.actual_spend, c.status,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE l.stage = 'won') as won,
              COALESCE(SUM(l.deal_value) FILTER (WHERE l.stage = 'won'), 0) as revenue
       FROM campaigns c
       LEFT JOIN leads l ON l.campaign_id = c.id
       WHERE c.tenant_id = $1
       GROUP BY c.id
       ORDER BY revenue DESC`,
      [req.tenantId]
    );

    const campaigns = result.rows.map(c => {
      const total = parseInt(c.total_leads);
      const won = parseInt(c.won);
      const spend = parseFloat(c.actual_spend) || 0;
      const revenue = parseFloat(c.revenue) || 0;
      return {
        ...c,
        total_leads: total,
        won,
        conversion_rate: total > 0 ? ((won / total) * 100).toFixed(1) : 0,
        cpl: total > 0 ? (spend / total).toFixed(2) : 0,
        roi: spend > 0 ? (((revenue - spend) / spend) * 100).toFixed(1) : 0,
      };
    });

    res.json({ campaigns });
  } catch (error) {
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/reports/timeline - Leads over time (daily)
const getTimeline = async (req, res) => {
  try {
    const { period = 'daily', days = 30 } = req.query;
    const truncFormat = period === 'monthly' ? 'month' : period === 'weekly' ? 'week' : 'day';

    const result = await query(
      `SELECT DATE_TRUNC('${truncFormat}', created_at) as period,
              COUNT(*) as total_leads,
              COUNT(*) FILTER (WHERE stage = 'won') as won,
              COALESCE(SUM(deal_value) FILTER (WHERE stage = 'won'), 0) as revenue
       FROM leads
       WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
       GROUP BY period ORDER BY period ASC`,
      [req.tenantId]
    );

    res.json({ timeline: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/reports/summary - Dashboard summary
const getDashboardSummary = async (req, res) => {
  try {
    const isStaff = req.user.role === 'staff';
    const baseParams = isStaff ? [req.tenantId, req.user.id] : [req.tenantId];
    const staffClause = isStaff ? ' AND assigned_to = $2' : '';
    const staffFollowupClause = isStaff
      ? ` AND lead_id IN (SELECT id FROM leads WHERE tenant_id = $1 AND assigned_to = $2)`
      : '';

    const summary = await query(
      `SELECT
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())) as leads_this_month,
        COUNT(*) FILTER (WHERE stage IN (SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) as total_won,
        COUNT(*) FILTER (WHERE stage IN (SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_won = true) AND won_at >= DATE_TRUNC('month', NOW())) as won_this_month,
        COUNT(*) FILTER (WHERE lead_score = 'hot') as hot_leads,
        COUNT(*) FILTER (WHERE lead_score = 'warm') as warm_leads,
        COUNT(*) FILTER (WHERE lead_score = 'cold') as cold_leads,
        COALESCE(SUM(deal_value) FILTER (WHERE stage IN (SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_won = true) AND won_at >= DATE_TRUNC('month', NOW())), 0) as revenue_this_month,
        COALESCE(SUM(deal_value) FILTER (WHERE stage IN (SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_won = true)), 0) as total_revenue
       FROM leads WHERE tenant_id = $1${staffClause}`,
      baseParams
    );

    const followups = await query(
      `SELECT
        COUNT(*) FILTER (WHERE DATE(scheduled_at) = CURRENT_DATE AND completed = false) as today,
        COUNT(*) FILTER (WHERE scheduled_at < NOW() AND completed = false) as overdue
       FROM followups WHERE tenant_id = $1${staffFollowupClause}`,
      baseParams
    );

    res.json({
      ...summary.rows[0],
      ...followups.rows[0],
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

module.exports = {
  getConversionReport, getReportBySource, getReportByStaff,
  getReportByCampaign, getTimeline, getDashboardSummary,
};
