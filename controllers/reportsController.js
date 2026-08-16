const { query } = require('../config/db');
const { MISSED_AFTER_HOURS, CRITICAL_AFTER_HOURS } = require('../utils/followupHealth');

// Resolves the ReportsPage ?period= selector (today|this_week|this_month|last_month|this_year)
// into a [start, end) range. Unrecognized/missing values default to this_month.
const resolvePeriodRange = (period) => {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();

  if (period === 'today') {
    const start = new Date(y, m, d);
    return { start, end: new Date(y, m, d + 1) };
  }
  if (period === 'this_week') {
    const diffToMonday = (now.getDay() + 6) % 7; // days since Monday
    const start = new Date(y, m, d - diffToMonday);
    return { start, end: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000) };
  }
  if (period === 'last_month') {
    return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
  }
  if (period === 'this_year') {
    return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
  }
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) }; // this_month (default)
};

// GET /api/reports/conversion - Overall conversion funnel
const getConversionReport = async (req, res) => {
  try {
    const { start, end } = resolvePeriodRange(req.query.period);
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, start, end, req.user.id] : [req.tenantId, start, end];
    const sc = isStaff ? ' AND assigned_to = $4' : '';

    const stages = await query(
      `SELECT stage, COUNT(*) as count, COALESCE(SUM(deal_value), 0) as value
       FROM leads WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3${sc}
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
    const { start, end } = resolvePeriodRange(req.query.period);
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, start, end, req.user.id] : [req.tenantId, start, end];
    const sc = isStaff ? ' AND assigned_to = $4' : '';

    const result = await query(
      `SELECT source,
              COUNT(*) as total_leads,
              COUNT(*) FILTER (WHERE stage = 'won') as won,
              COUNT(*) FILTER (WHERE stage = 'lost') as lost,
              COALESCE(SUM(deal_value) FILTER (WHERE stage = 'won'), 0) as revenue
       FROM leads WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3${sc}
       GROUP BY source ORDER BY total_leads DESC`,
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
    const { start, end } = resolvePeriodRange(req.query.period);
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, start, end, req.user.id] : [req.tenantId, start, end];
    const userFilter = isStaff ? ' AND u.id = $4' : '';

    const result = await query(
      `SELECT u.id, u.name, u.email,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE l.stage = 'won') as won,
              COUNT(l.id) FILTER (WHERE l.stage = 'lost') as lost,
              COALESCE(SUM(l.deal_value) FILTER (WHERE l.stage = 'won'), 0) as revenue,
              ROUND(AVG(l.response_time_seconds) FILTER (WHERE l.response_time_seconds IS NOT NULL)) as avg_response_seconds,
              (SELECT COUNT(*) FROM lead_followups lf JOIN leads l2 ON l2.id = lf.lead_id
                WHERE l2.tenant_id = u.tenant_id AND l2.assigned_to = u.id AND lf.is_completed = false) as pending_followups,
              (SELECT COUNT(*) FROM lead_followups lf JOIN leads l2 ON l2.id = lf.lead_id
                WHERE l2.tenant_id = u.tenant_id AND l2.assigned_to = u.id AND lf.is_completed = true) as completed_followups,
              -- AI messages don't record sent_by, so attribute them to the lead's assigned staff instead
              (SELECT COUNT(*) FROM whatsapp_messages wm JOIN leads l3 ON l3.id = wm.lead_id
                WHERE l3.tenant_id = u.tenant_id AND l3.assigned_to = u.id AND wm.direction = 'outbound'
                  AND wm.is_ai_generated = true AND wm.sent_at >= $2 AND wm.sent_at < $3) as ai_sent,
              (SELECT COUNT(*) FROM whatsapp_messages wm JOIN leads l3 ON l3.id = wm.lead_id
                WHERE l3.tenant_id = u.tenant_id AND l3.assigned_to = u.id AND wm.direction = 'outbound'
                  AND wm.is_ai_generated = false AND wm.sent_at >= $2 AND wm.sent_at < $3) as manual_sent
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id AND l.tenant_id = u.tenant_id
         AND l.created_at >= $2 AND l.created_at < $3
       WHERE u.tenant_id = $1 AND u.is_active = true${userFilter}
       GROUP BY u.id, u.name, u.email, u.tenant_id
       ORDER BY revenue DESC`,
      params
    );

    const staff = result.rows.map(s => ({
      ...s,
      total_leads: parseInt(s.total_leads),
      won: parseInt(s.won),
      lost: parseInt(s.lost),
      avg_response_seconds: s.avg_response_seconds !== null ? parseInt(s.avg_response_seconds) : null,
      pending_followups: parseInt(s.pending_followups),
      completed_followups: parseInt(s.completed_followups),
      ai_sent: parseInt(s.ai_sent),
      manual_sent: parseInt(s.manual_sent),
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
    const { start, end } = resolvePeriodRange(req.query.period);
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, start, end, req.user.id] : [req.tenantId, start, end];
    const staffJoin = isStaff ? ' AND l.assigned_to = $4' : '';

    const result = await query(
      `SELECT c.id, c.name, c.source, c.budget, c.actual_spend, c.status,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE l.stage = 'won') as won,
              COALESCE(SUM(l.deal_value) FILTER (WHERE l.stage = 'won'), 0) as revenue
       FROM campaigns c
       LEFT JOIN leads l ON l.campaign_id = c.id
         AND l.created_at >= $2 AND l.created_at < $3${staffJoin}
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

// GET /api/reports/funnel - Stage-to-stage drop-off, and which stage leads leak (are lost) from.
// NOTE: lead_stage_history inserts are non-blocking (see leadController.js updateLead), so a lead
// whose history write silently failed is invisible to the "leaks" breakdown — a tolerated gap,
// not backfilled here.
const getFunnelReport = async (req, res) => {
  try {
    const { start, end } = resolvePeriodRange(req.query.period);
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, start, end, req.user.id] : [req.tenantId, start, end];
    const cohortSc = isStaff ? ' AND assigned_to = $4' : '';
    const leaksSc = isStaff ? ' AND l.assigned_to = $4' : '';

    const [stagesRes, leaksRes] = await Promise.all([
      query(
        `WITH cohort AS (
           SELECT id, stage FROM leads
           WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3${cohortSc}
         ),
         all_stages AS (
           SELECT id, name, pos, is_won, is_lost FROM lead_stages WHERE tenant_id = $1 AND is_active = true
         ),
         lead_max_pos AS (
           -- Default to pos 1 (not 0) when a lead's current stage string doesn't match any
           -- active lead_stages row (e.g. it still holds the hardcoded 'new' default from
           -- creation while this tenant's actual first stage is named something else) — every
           -- created lead has at minimum entered the pipeline, so it must count at the first bar.
           SELECT c.id AS lead_id,
             GREATEST(
               COALESCE((SELECT s.pos FROM all_stages s WHERE LOWER(s.name) = LOWER(c.stage)), 1),
               COALESCE((SELECT MAX(s2.pos) FROM lead_stage_history h
                          JOIN all_stages s2 ON LOWER(s2.name) = LOWER(h.new_stage)
                          WHERE h.lead_id = c.id), 0)
             ) AS max_pos
           FROM cohort c
         )
         SELECT s.id, s.name, s.pos, s.is_won, s.is_lost,
                COUNT(lmp.lead_id) FILTER (WHERE lmp.max_pos >= s.pos) AS reached_count
         FROM all_stages s
         LEFT JOIN lead_max_pos lmp ON true
         WHERE s.is_won = false AND s.is_lost = false
         GROUP BY s.id, s.name, s.pos, s.is_won, s.is_lost
         ORDER BY s.pos ASC`,
        params
      ),
      query(
        `SELECT h.prev_stage AS from_stage, COUNT(*) AS lost_count,
                COALESCE(SUM(l.deal_value), 0) AS lost_value
         FROM lead_stage_history h
         JOIN leads l ON l.id = h.lead_id
         JOIN lead_stages s ON LOWER(s.name) = LOWER(h.new_stage) AND s.tenant_id = h.tenant_id
         WHERE h.tenant_id = $1 AND s.is_lost = true
           AND l.created_at >= $2 AND l.created_at < $3${leaksSc}
         GROUP BY h.prev_stage
         ORDER BY lost_count DESC`,
        params
      ),
    ]);

    const parsedStages = stagesRes.rows.map(s => ({ ...s, reached_count: parseInt(s.reached_count) }));
    const stages = parsedStages.map((s, i) => {
      const prevReached = i > 0 ? parsedStages[i - 1].reached_count : s.reached_count;
      return {
        ...s,
        drop_off_count: i > 0 ? Math.max(0, prevReached - s.reached_count) : 0,
        drop_off_pct: i > 0 && prevReached > 0 ? (((prevReached - s.reached_count) / prevReached) * 100).toFixed(1) : '0.0',
      };
    });

    const leaks = leaksRes.rows.map(l => ({
      from_stage: l.from_stage,
      lost_count: parseInt(l.lost_count),
      lost_value: parseFloat(l.lost_value),
    }));

    res.json({ stages, leaks });
  } catch (error) {
    console.error('Funnel report error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/reports/time-in-stage - Average dwell time per stage, plus how many leads are
// currently sitting in each one. Builds a synthetic per-lead event timeline (leads.created_at
// as entry into the earliest known stage, unioned with every lead_stage_history row) so stage
// duration can be computed even though no history row exists for a lead's very first stage.
const getTimeInStageReport = async (req, res) => {
  try {
    const { start, end } = resolvePeriodRange(req.query.period);
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, start, end, req.user.id] : [req.tenantId, start, end];
    const cohortSc = isStaff ? ' AND assigned_to = $4' : '';

    const result = await query(
      `WITH cohort AS (
         SELECT id, stage, created_at FROM leads
         WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3${cohortSc}
       ),
       initial_stage AS (
         SELECT c.id AS lead_id, c.created_at AS entered_at,
           COALESCE(
             (SELECT h.prev_stage FROM lead_stage_history h
               WHERE h.lead_id = c.id AND h.new_stage IS NOT NULL
               ORDER BY h.changed_at ASC LIMIT 1),
             c.stage
           ) AS stage
         FROM cohort c
       ),
       events AS (
         SELECT lead_id, entered_at, stage FROM initial_stage
         UNION ALL
         -- lead_stage_history also logs pure status-only changes (prev_stage/new_stage both
         -- NULL) — exclude those, they're not real stage transitions and would otherwise
         -- fragment the timeline and corrupt "current stage" resolution.
         SELECT h.lead_id, h.changed_at AS entered_at, h.new_stage AS stage
         FROM lead_stage_history h
         JOIN cohort c ON c.id = h.lead_id
         WHERE h.new_stage IS NOT NULL
       ),
       occupancy AS (
         SELECT lead_id, stage, entered_at,
                LEAD(entered_at) OVER (PARTITION BY lead_id ORDER BY entered_at) AS left_at
         FROM events
       )
       SELECT ls.name AS stage, ls.pos, ls.color,
              ROUND(AVG(EXTRACT(EPOCH FROM (o.left_at - o.entered_at))) FILTER (WHERE o.left_at IS NOT NULL)) AS avg_seconds_in_stage,
              COUNT(*) FILTER (WHERE o.left_at IS NULL) AS currently_in_stage
       FROM occupancy o
       LEFT JOIN lead_stages ls ON LOWER(ls.name) = LOWER(o.stage) AND ls.tenant_id = $1
       GROUP BY ls.name, ls.pos, ls.color
       ORDER BY ls.pos ASC NULLS LAST`,
      params
    );

    const stages = result.rows.map(r => ({
      ...r,
      // Leads whose current/historical stage name no longer matches any active lead_stages
      // row (e.g. a stage was renamed since) land here instead of being silently dropped.
      stage: r.stage || 'Other / Legacy Stage',
      avg_seconds_in_stage: r.avg_seconds_in_stage !== null ? parseInt(r.avg_seconds_in_stage) : null,
      currently_in_stage: parseInt(r.currently_in_stage),
    }));

    res.json({ stages });
  } catch (error) {
    console.error('Time-in-stage report error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/reports/followup-trend - Scheduled vs completed follow-ups over time
const getFollowupTrend = async (req, res) => {
  try {
    const { period = 'daily', days = 30 } = req.query;
    const truncFormat = period === 'monthly' ? 'month' : period === 'weekly' ? 'week' : 'day';
    const isStaff = req.user.role === 'staff';
    const params = isStaff ? [req.tenantId, req.user.id] : [req.tenantId];
    const sc = isStaff ? ' AND l.assigned_to = $2' : '';

    const result = await query(
      `SELECT DATE_TRUNC('${truncFormat}', lf.created_at) as period,
              COUNT(*) as scheduled,
              COUNT(*) FILTER (WHERE lf.is_completed = true) as completed
       FROM lead_followups lf
       JOIN leads l ON l.id = lf.lead_id
       WHERE lf.tenant_id = $1 AND lf.created_at >= NOW() - INTERVAL '${parseInt(days)} days'${sc}
       GROUP BY period ORDER BY period ASC`,
      params
    );

    res.json({
      trend: result.rows.map(r => ({
        ...r,
        scheduled: parseInt(r.scheduled),
        completed: parseInt(r.completed),
      })),
    });
  } catch (error) {
    console.error('Followup trend error:', error);
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
              COALESCE(SUM(deal_value) FILTER (WHERE stage = 'won'), 0) as revenue,
              ROUND(AVG(response_time_seconds) FILTER (WHERE response_time_seconds IS NOT NULL)) as avg_response_seconds,
              COUNT(*) FILTER (WHERE response_time_seconds IS NOT NULL) as responded_count
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
// Resolves the ?period=this_month|last_month|custom (&date_from&date_to) query params
// into a [start, end) range, plus the immediately preceding period of equal length
// for "vs previous period" comparisons.
const resolveDashboardRange = ({ period, date_from, date_to }) => {
  const now = new Date();

  if (period === 'last_month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return { start, end, prevStart, prevEnd: start };
  }

  if (period === 'custom' && date_from && date_to) {
    const start = new Date(date_from);
    const end = new Date(date_to);
    end.setDate(end.getDate() + 1); // make end-of-day inclusive
    const prevStart = new Date(start.getTime() - (end.getTime() - start.getTime()));
    return { start, end, prevStart, prevEnd: start };
  }

  // Default: this month
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { start, end, prevStart, prevEnd: start };
};

const getDashboardSummary = async (req, res) => {
  try {
    const tid = req.tenantId;
    const isStaff = req.user.role === 'staff';
    const uid = isStaff ? req.user.id : null;
    const { start, end, prevStart, prevEnd } = resolveDashboardRange(req.query);

    // Postgres requires every placeholder number up to the highest referenced to actually
    // appear in the query text (gaps break type inference), so each query below gets only
    // the params it actually uses, numbered contiguously from $1.
    // compareParams: $1 tenant, $2 range start, $3 range end, $4 prev start, $5 prev end, $6 staff id (nullable)
    const compareParams = [tid, start, end, prevStart, prevEnd, uid];
    // rangeParams: $1 tenant, $2 range start, $3 range end, $4 staff id (nullable)
    const rangeParams = [tid, start, end, uid];
    const rsc = ' AND ($4::uuid IS NULL OR assigned_to = $4)';
    // liveParams: $1 tenant, $2 staff id (nullable) — for always-live, non-period-scoped queries
    const liveParams = [tid, uid];
    const lsfc = ' AND ($2::uuid IS NULL OR lead_id IN (SELECT id FROM leads WHERE tenant_id = $1 AND assigned_to = $2))';

    const [summary, followupStats, pipeline, sources, team, recentLeads, trend, unassigned, automation] = await Promise.all([

      // Core KPIs — selected period vs the immediately preceding period of equal length
      query(`
        SELECT
          COUNT(*) as total_leads,
          COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3) as leads_in_period,
          COUNT(*) FILTER (WHERE created_at >= $4 AND created_at < $5) as leads_prev_period,
          COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('day', NOW())) as leads_today,
          COUNT(*) FILTER (WHERE lead_score = 'hot') as hot_leads,
          COUNT(*) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) as total_won,
          COUNT(*) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)
            AND won_at >= $2 AND won_at < $3) as won_in_period,
          COALESCE(SUM(deal_value) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)), 0) as total_revenue,
          COALESCE(SUM(deal_value) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)
            AND won_at >= $2 AND won_at < $3), 0) as revenue_in_period,
          COALESCE(SUM(deal_value) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)
            AND won_at >= $4 AND won_at < $5), 0) as revenue_prev_period,
          COALESCE(SUM(advance_received) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)
            AND won_at >= $2 AND won_at < $3), 0) as advance_collected_in_period,
          COALESCE(SUM(deal_value - advance_received) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)
            AND won_at >= $2 AND won_at < $3), 0) as balance_due_in_period
        FROM leads WHERE tenant_id = $1${' AND ($6::uuid IS NULL OR assigned_to = $6)'}
      `, compareParams),

      // Today's action items from lead_followups — always live, not period-scoped
      query(`
        SELECT
          COUNT(*) FILTER (WHERE DATE(next_followup_at) = CURRENT_DATE AND is_completed = false) as today,
          COUNT(*) FILTER (WHERE next_followup_at < NOW() AND is_completed = false) as overdue,
          COUNT(*) FILTER (WHERE followup_type = 'demo' AND DATE(next_followup_at) = CURRENT_DATE AND is_completed = false) as demos_today,
          COUNT(*) FILTER (WHERE is_completed = false AND next_followup_at < NOW() - INTERVAL '${MISSED_AFTER_HOURS} hours'
                           AND next_followup_at >= NOW() - INTERVAL '${CRITICAL_AFTER_HOURS} hours') as missed,
          COUNT(*) FILTER (WHERE is_completed = false AND next_followup_at < NOW() - INTERVAL '${CRITICAL_AFTER_HOURS} hours') as critical
        FROM lead_followups WHERE tenant_id = $1${lsfc}
      `, liveParams),

      // Pipeline: leads created in the selected period, per stage
      query(`
        SELECT ls.name, ls.color, ls.pos, ls.is_won, ls.is_lost,
               COUNT(l.id) as count,
               COALESCE(SUM(l.deal_value), 0) as pipeline_value
        FROM lead_stages ls
        LEFT JOIN leads l ON LOWER(l.stage) = LOWER(ls.name) AND l.tenant_id = ls.tenant_id
          AND l.created_at >= $2 AND l.created_at < $3
          AND ($4::uuid IS NULL OR l.assigned_to = $4)
        WHERE ls.tenant_id = $1 AND ls.is_active = true
        GROUP BY ls.id, ls.name, ls.color, ls.pos, ls.is_won, ls.is_lost
        ORDER BY ls.pos ASC
      `, rangeParams),

      // Lead sources — top 6, leads created in the selected period
      query(`
        SELECT
          COALESCE(source, 'Unknown') as source,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE LOWER(stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) as won
        FROM leads WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3${rsc}
        GROUP BY source ORDER BY total DESC LIMIT 6
      `, rangeParams),

      // Team performance — admin sees all; staff sees only themselves. Leads created in period.
      query(`
        SELECT
          u.name,
          COUNT(l.id) as total_leads,
          COUNT(l.id) FILTER (WHERE LOWER(l.stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)) as won,
          COALESCE(SUM(l.deal_value) FILTER (WHERE LOWER(l.stage) IN (
            SELECT LOWER(name) FROM lead_stages WHERE tenant_id = $1 AND is_won = true)), 0) as revenue,
          ROUND(AVG(l.response_time_seconds) FILTER (WHERE l.response_time_seconds IS NOT NULL)) as avg_response_seconds,
          (SELECT COUNT(*) FROM lead_followups lf JOIN leads l2 ON l2.id = lf.lead_id
            WHERE l2.tenant_id = $1 AND l2.assigned_to = u.id
              AND lf.is_completed = true AND lf.completed_at >= $2 AND lf.completed_at < $3) as completed_followups
        FROM users u
        LEFT JOIN leads l ON l.assigned_to = u.id AND l.tenant_id = $1
          AND l.created_at >= $2 AND l.created_at < $3
        WHERE u.tenant_id = $1 AND u.is_active = true AND u.role IN ('admin', 'staff')
          AND ($4::uuid IS NULL OR u.id = $4)
        GROUP BY u.id, u.name ORDER BY won DESC, total_leads DESC LIMIT 8
      `, rangeParams),

      // Recent 6 leads — from the selected period
      query(`
        SELECT id, name, phone, source, lead_score, stage, created_at
        FROM leads WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3${rsc}
        ORDER BY created_at DESC LIMIT 6
      `, rangeParams),

      // Daily lead-creation trend across the selected period
      query(`
        SELECT DATE_TRUNC('day', created_at) as day, COUNT(*) as count
        FROM leads WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3${rsc}
        GROUP BY day ORDER BY day ASC
      `, rangeParams),

      // Unassigned leads (admin only) — always live
      isStaff
        ? Promise.resolve({ rows: [{ count: '0' }] })
        : query('SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND assigned_to IS NULL', [tid]),

      // Automation & AI activity — always live (not period-scoped)
      query(`
        SELECT
          (SELECT COUNT(*) FROM automation_enrollments WHERE tenant_id = $1 AND status = 'active') as active_enrollments,
          (SELECT COUNT(*) FROM automation_enrollments WHERE tenant_id = $1 AND status = 'completed'
            AND completed_at >= DATE_TRUNC('month', NOW())) as completed_this_month,
          (SELECT COUNT(*) FROM whatsapp_messages WHERE tenant_id = $1 AND is_ai_generated = true
            AND sent_at >= NOW() - INTERVAL '7 days') as ai_replies_this_week,
          (SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND source = 'meta_ads'
            AND created_at >= DATE_TRUNC('day', NOW())) as meta_leads_today
      `, [tid]),
    ]);

    const s = summary.rows[0];
    const f = followupStats.rows[0];

    const pct = (curr, prev) => {
      const c = parseFloat(curr) || 0, p = parseFloat(prev) || 0;
      if (p === 0) return c > 0 ? 100 : 0;
      return Math.round(((c - p) / p) * 100);
    };

    res.json({
      period_start: start.toISOString(),
      period_end:   new Date(end.getTime() - 1).toISOString(), // inclusive last moment, for display

      total_leads:       parseInt(s.total_leads),
      leads_today:       parseInt(s.leads_today),
      leads_in_period:   parseInt(s.leads_in_period),
      leads_change:      pct(s.leads_in_period, s.leads_prev_period),
      hot_leads:         parseInt(s.hot_leads),
      total_won:         parseInt(s.total_won),
      won_in_period:     parseInt(s.won_in_period),
      total_revenue:     parseFloat(s.total_revenue),
      revenue_in_period: parseFloat(s.revenue_in_period),
      revenue_change:    pct(s.revenue_in_period, s.revenue_prev_period),
      advance_collected_in_period: parseFloat(s.advance_collected_in_period),
      balance_due_in_period: parseFloat(s.balance_due_in_period),
      conversion_rate:   s.leads_in_period > 0
                          ? ((s.won_in_period / s.leads_in_period) * 100).toFixed(1)
                          : '0.0',
      avg_deal_value:    s.won_in_period > 0 ? Math.round(s.revenue_in_period / s.won_in_period) : 0,

      followups_today:   parseInt(f.today),
      overdue_followups: parseInt(f.overdue),
      demos_today:       parseInt(f.demos_today),
      missed_followups:  parseInt(f.missed),
      critical_followups: parseInt(f.critical),

      unassigned_leads: isStaff ? 0 : parseInt(unassigned.rows[0].count),

      active_enrollments:    parseInt(automation.rows[0].active_enrollments),
      completed_this_month:  parseInt(automation.rows[0].completed_this_month),
      ai_replies_this_week:  parseInt(automation.rows[0].ai_replies_this_week),
      meta_leads_today:      parseInt(automation.rows[0].meta_leads_today),

      pipeline:    pipeline.rows.map(p => ({ ...p, count: parseInt(p.count), pipeline_value: parseFloat(p.pipeline_value) })),
      sources:     sources.rows.map(s => ({ ...s, total: parseInt(s.total), won: parseInt(s.won), conversion_rate: s.total > 0 ? ((s.won / s.total) * 100).toFixed(1) : '0.0' })),
      team:        team.rows.map(t => ({
        ...t,
        total_leads: parseInt(t.total_leads),
        won: parseInt(t.won),
        revenue: parseFloat(t.revenue),
        avg_response_seconds: t.avg_response_seconds !== null ? parseInt(t.avg_response_seconds) : null,
        completed_followups: parseInt(t.completed_followups),
      })),
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
  getFunnelReport, getTimeInStageReport, getFollowupTrend,
};
