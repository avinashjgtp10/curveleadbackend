const { query } = require('../config/db');
const { generatePlaybookForTenant } = require('../jobs/playbookGenerator');

// GET /api/playbook — latest playbook version for this tenant
const getPlaybook = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM sales_playbooks WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1',
      [req.tenantId]
    );
    res.json({ playbook: result.rows[0] || null });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/playbook/generate — regenerate now (admin)
const regeneratePlaybook = async (req, res) => {
  try {
    const result = await generatePlaybookForTenant(req.tenantId);
    if (result.skipped) return res.status(400).json({ error: result.reason });
    res.status(201).json({ playbook: result.playbook });
  } catch (e) {
    console.error('regeneratePlaybook error:', e.message);
    res.status(500).json({ error: 'Failed to generate playbook.' });
  }
};

// GET /api/playbook/coaching — per-staff call quality + conversion stats
const getCoaching = async (req, res) => {
  try {
    const tid = req.tenantId;

    const staffResult = await query(
      `SELECT u.id, u.name,
              COUNT(l.id) as total_leads,
              COUNT(l.id) FILTER (WHERE LOWER(l.stage) IN (
                SELECT LOWER(name) FROM lead_stages WHERE tenant_id=$1 AND is_won=true)) as won
       FROM users u
       LEFT JOIN leads l ON l.assigned_to = u.id AND l.tenant_id = $1
       WHERE u.tenant_id = $1 AND u.is_active = true AND u.role IN ('admin','staff')
       GROUP BY u.id, u.name ORDER BY u.name ASC`,
      [tid]
    );

    const callsResult = await query(
      `SELECT uploaded_by, analysis
       FROM call_recordings
       WHERE tenant_id=$1 AND analysis_status='done' AND analysis IS NOT NULL AND uploaded_by IS NOT NULL`,
      [tid]
    );

    // Aggregate call-quality metrics per staff member in JS — small enough
    // dataset per tenant that this is simpler and clearer than a JSONB-heavy SQL query.
    const byStaff = {};
    for (const row of callsResult.rows) {
      const s = byStaff[row.uploaded_by] || (byStaff[row.uploaded_by] = { scores: [], sentiments: {}, missed: {} });
      const a = row.analysis;
      if (typeof a.overall_score === 'number') s.scores.push(a.overall_score);
      if (a.customer_sentiment) s.sentiments[a.customer_sentiment] = (s.sentiments[a.customer_sentiment] || 0) + 1;
      for (const m of a.pitch_missed || []) s.missed[m] = (s.missed[m] || 0) + 1;
    }

    const allScores = Object.values(byStaff).flatMap(s => s.scores);
    const teamAvgScore = allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : null;

    const staff = staffResult.rows.map(row => {
      const calls = byStaff[row.id];
      const avgScore = calls?.scores.length ? calls.scores.reduce((a, b) => a + b, 0) / calls.scores.length : null;
      const topMissed = calls
        ? Object.entries(calls.missed).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([text]) => text)
        : [];
      return {
        id: row.id,
        name: row.name,
        total_leads: parseInt(row.total_leads),
        won: parseInt(row.won),
        conversion_rate: row.total_leads > 0 ? +((row.won / row.total_leads) * 100).toFixed(1) : 0,
        call_count: calls?.scores.length || 0,
        avg_score: avgScore !== null ? +avgScore.toFixed(1) : null,
        score_vs_team: avgScore !== null && teamAvgScore !== null ? +(avgScore - teamAvgScore).toFixed(1) : null,
        top_missed: topMissed,
      };
    });

    res.json({ staff, team_avg_score: teamAvgScore !== null ? +teamAvgScore.toFixed(1) : null });
  } catch (e) {
    console.error('getCoaching error:', e.message);
    res.status(500).json({ error: 'Failed.' });
  }
};

module.exports = { getPlaybook, regeneratePlaybook, getCoaching };
