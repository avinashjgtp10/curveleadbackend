const { query } = require('../config/db');

// GET /api/reports/conversion - Overall conversion funnel
const getConversionReport = async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, req.user.id] : [req.tenantId];
    const sc = isStaff ? ' AND assigned_to = $2' : '';

    let dateFilter = '';
    const dateParamBase = params.length + 1;
    const extraParams = [];

    if (date_from) {
      dateFilter += ` AND created_at >= $${dateParamBase + extraParams.length}`;
      extraParams.push(date_from);
    }
    if (date_to) {
      dateFilter += ` AND created_at <= $${dateParamBase + extraParams.length}::date + INTERVAL '1 day'`;
      extraParams.push(date_to);
    }

    const stages = await query(
      `SELECT stage, COUNT(*) as count, COALESCE(SUM(deal_value), 0) as value
       FROM leads WHERE tenant_id = $1${sc} ${dateFilter}
       GROUP BY stage ORDER BY count DESC`,
      [...params, ...extraParams]
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
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, req.user.id] : [req.tenantId];
    const sc = isStaff ? ' AND assigned_to = $2' : '';

    const result = await query(
      `SELECT source,
              COUNT(*) as total_leads,
              COUNT(*) FILTER (WHERE stage = 'won') as won,
              COUNT(*) FILTER (WHERE stage = 'lost') as lost,
              COALESCE(SUM(deal_value) FILTER (WHERE stage = 'won'), 0) as revenue
       FROM leads WHERE tenant_id = $1${sc} GROUP BY source ORDER BY total_leads DESC`,
      params
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

// GET /api/reports/by-staff - Conversion by team member (admin sees all; staff sees only self)
const getReportByStaff = async (req, res) => {
  try {
    const isStaff = req.user.role === 'staff';
    const params = [req.tenantId];
    const userFilter = isStaff ? ' AND u.id = $2' : '';
    if (isStaff) params.push(req.user.id);

    const result = await query(
      `SELECT u.id, u.name, u.email,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE l.stage = 'won') as won,
              COUNT(l.id) FILTER (WHERE l.stage = 'lost') as lost,
              COALESCE(SUM(l.deal_value) FILTER (WHERE l.stage = 'won'), 0) as revenue,
              (SELECT COUNT(*) FROM followups WHERE assigned_to = u.id AND completed = false) as pending_followups
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id AND l.tenant_id = u.tenant_id
       WHERE u.tenant_id = $1 AND u.is_active = true${userFilter}
       GROUP BY u.id, u.name, u.email
       ORDER BY revenue DESC`,
      params
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
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, req.user.id] : [req.tenantId];
    const staffJoin = isStaff ? ' AND l.assigned_to = $2' : '';

    const result = await query(
      `SELECT c.id, c.name, c.source, c.budget, c.actual_spend, c.status,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE l.stage = 'won') as won,
              COALESCE(SUM(l.deal_value) FILTER (WHERE l.stage = 'won'), 0) as revenue
       FROM campaigns c
       LEFT JOIN leads l ON l.campaign_id = c.id${staffJoin}
       WHERE c.tenant_id = $1
       GROUP BY c.id
       ORDER BY revenue DESC`,
      params
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
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, req.user.id] : [req.tenantId];
    const sc = isStaff ? ' AND assigned_to = $2' : '';

    const result = await query(
      `SELECT DATE_TRUNC('${truncFormat}', created_at) as period,
              COUNT(*) as total_leads,
              COUNT(*) FILTER (WHERE stage = 'won') as won,
              COALESCE(SUM(deal_value) FILTER (WHERE stage = 'won'), 0) as revenue
       FROM leads
       WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'${sc}
       GROUP BY period ORDER BY period ASC`,
      params
    );

    res.json({ timeline: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/reports/summary - Dashboard summary
const getDashboardSummary = async (req, res) => {
  try {
    const tid = req.tenantId;
    const isStaff = req.user.role === 'staff';
    const uid = req.user.id;
    const baseParams = isStaff ? [tid, uid] : [tid];
    const sc = isStaff ? ' AND assigned_to = $2' : '';
    const sfc = isStaff
      ? ' AND lead_id IN (SELECT id FROM leads WHERE tenant_id = $1 AND assigned_to = $2)'
      : '';

    const [summary, followupStats, pipeline, sources, team, recentLeads, trend] = await Promise.all([

      // Core KPIs — this month vs last month
      query(`
        SELECT
          COUNT(*) as total_leads,
          COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW())) as leads_this_month,
          COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
                           AND created_at < DATE_TRUNC('month', NOW())) as leads_last_month,
          COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('day', NOW())) as leads_today,
          COUNT(*) FILTER (WHERE lead_score = 'hot') as hot_leads,
          COUNT(*) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) as total_won,
          COUNT(*) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)
            AND won_at >= DATE_TRUNC('month', NOW())) as won_this_month,
          COALESCE(SUM(deal_value) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)), 0) as total_revenue,
          COALESCE(SUM(deal_value) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)
            AND won_at >= DATE_TRUNC('month', NOW())), 0) as revenue_this_month,
          COALESCE(SUM(deal_value) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)
            AND won_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
            AND won_at < DATE_TRUNC('month', NOW())), 0) as revenue_last_month,
          COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
                           AND created_at < DATE_TRUNC('month', NOW())) as _leads_lm
        FROM leads WHERE tenant_id = $1${sc}
      `, baseParams),

      // Today's action items from lead_followups
      query(`
        SELECT
          COUNT(*) FILTER (WHERE DATE(next_followup_at) = CURRENT_DATE AND is_completed = false) as today,
          COUNT(*) FILTER (WHERE next_followup_at < NOW() AND is_completed = false) as overdue,
          COUNT(*) FILTER (WHERE followup_type = 'demo' AND DATE(next_followup_at) = CURRENT_DATE AND is_completed = false) as demos_today
        FROM lead_followups WHERE tenant_id = $1${sfc}
      `, baseParams),

      // Pipeline: leads per stage
      query(`
        SELECT ls.name, ls.color, ls.pos, ls.is_won, ls.is_lost,
               COUNT(l.id) as count,
               COALESCE(SUM(l.deal_value), 0) as pipeline_value
        FROM lead_stages ls
        LEFT JOIN leads l ON LOWER(l.stage) = LOWER(ls.name) AND l.tenant_id = ls.tenant_id${isStaff ? ' AND l.assigned_to = $2' : ''}
        WHERE ls.tenant_id = $1 AND ls.is_active = true
        GROUP BY ls.id, ls.name, ls.color, ls.pos, ls.is_won, ls.is_lost
        ORDER BY ls.pos ASC
      `, baseParams),

      // Lead sources — top 6
      query(`
        SELECT
          COALESCE(source, 'Unknown') as source,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) as won
        FROM leads WHERE tenant_id = $1${sc}
        GROUP BY source ORDER BY total DESC LIMIT 6
      `, baseParams),

      // Team performance — admin sees all; staff sees only themselves
      isStaff
        ? query(`
            SELECT
              u.name,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE LOWER(l.stage) IN (
                SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) as won,
              COALESCE(SUM(l.deal_value) FILTER (WHERE LOWER(l.stage) IN (
                SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)), 0) as revenue
            FROM users u
            LEFT JOIN leads l ON l.assigned_to = u.id AND l.tenant_id = $1
            WHERE u.tenant_id = $1 AND u.id = $2
            GROUP BY u.id, u.name
          `, baseParams)
        : query(`
            SELECT
              u.name,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE LOWER(l.stage) IN (
                SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) as won,
              COALESCE(SUM(l.deal_value) FILTER (WHERE LOWER(l.stage) IN (
                SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)), 0) as revenue
            FROM users u
            LEFT JOIN leads l ON l.assigned_to = u.id AND l.tenant_id = $1
            WHERE u.tenant_id = $1 AND u.is_active = true AND u.role IN ('admin', 'staff')
            GROUP BY u.id, u.name ORDER BY won DESC, total_leads DESC LIMIT 8
          `, [tid]),

      // Recent 6 leads
      query(`
        SELECT id, name, phone, source, lead_score, stage, created_at
        FROM leads WHERE tenant_id = $1${sc} ORDER BY created_at DESC LIMIT 6
      `, baseParams),

      // Last 14-day trend
      query(`
        SELECT DATE_TRUNC('day', created_at) as day, COUNT(*) as count
        FROM leads WHERE tenant_id = $1${sc} AND created_at >= NOW() - INTERVAL '14 days'
        GROUP BY day ORDER BY day ASC
      `, baseParams),
    ]);

    const s = summary.rows[0];
    const f = followupStats.rows[0];

    const pct = (curr, prev) => {
      const c = parseFloat(curr) || 0, p = parseFloat(prev) || 0;
      if (p === 0) return c > 0 ? 100 : 0;
      return Math.round(((c - p) / p) * 100);
    };

    res.json({
      total_leads:       parseInt(s.total_leads),
      leads_today:       parseInt(s.leads_today),
      leads_this_month:  parseInt(s.leads_this_month),
      leads_last_month:  parseInt(s.leads_last_month),
      leads_change:      pct(s.leads_this_month, s._leads_lm),
      hot_leads:         parseInt(s.hot_leads),
      total_won:         parseInt(s.total_won),
      won_this_month:    parseInt(s.won_this_month),
      total_revenue:     parseFloat(s.total_revenue),
      revenue_this_month: parseFloat(s.revenue_this_month),
      revenue_last_month: parseFloat(s.revenue_last_month),
      revenue_change:    pct(s.revenue_this_month, s.revenue_last_month),
      conversion_rate:   s.leads_this_month > 0
                          ? ((s.won_this_month / s.leads_this_month) * 100).toFixed(1)
                          : '0.0',
      avg_deal_value:    s.total_won > 0 ? Math.round(s.total_revenue / s.total_won) : 0,

      followups_today:   parseInt(f.today),
      overdue_followups: parseInt(f.overdue),
      demos_today:       parseInt(f.demos_today),

      pipeline:    pipeline.rows.map(p => ({ ...p, count: parseInt(p.count), pipeline_value: parseFloat(p.pipeline_value) })),
      sources:     sources.rows.map(s => ({ ...s, total: parseInt(s.total), won: parseInt(s.won), conversion_rate: s.total > 0 ? ((s.won / s.total) * 100).toFixed(1) : '0.0' })),
      team:        team.rows.map(t => ({ ...t, total_leads: parseInt(t.total_leads), won: parseInt(t.won), revenue: parseFloat(t.revenue) })),
      recentLeads: recentLeads.rows,
      trend:       trend.rows,
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
