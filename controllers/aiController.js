const { query } = require('../config/db');
const { scoreLead, qualifyLead, summarizeLead } = require('../services/groqService');

// POST /api/ai/score-lead/:id - Score a single lead
const scoreLeadById = async (req, res) => {
  try {
    const leadResult = await query(
      'SELECT * FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const lead = leadResult.rows[0];

    // Get recent activity
    const activityResult = await query(
      `SELECT title, description, created_at FROM lead_activities
       WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );
    const recent_activity = activityResult.rows.map(a => a.title).join('; ');

    const scoring = await scoreLead({ ...lead, recent_activity });

    // Update lead
    await query(
      `UPDATE leads SET lead_score = $1, score_reason = $2, score_updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4`,
      [scoring.score, scoring.reason, req.params.id, req.tenantId]
    );

    // Log activity
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1, $2, 'score_change', $3, $4, $5)`,
      [req.tenantId, req.params.id, `AI scored as ${scoring.score}`, scoring.reason, req.user.id]
    );

    res.json({ scoring });
  } catch (error) {
    console.error('Score lead error:', error);
    res.status(500).json({ error: error.message || 'Failed to score lead.' });
  }
};

// POST /api/ai/score-bulk - Score all unscored leads
const scoreBulkLeads = async (req, res) => {
  try {
    const leads = await query(
      `SELECT * FROM leads WHERE tenant_id = $1 AND (score_updated_at IS NULL OR score_updated_at < NOW() - INTERVAL '7 days')
       LIMIT 50`,
      [req.tenantId]
    );

    const results = [];
    for (const lead of leads.rows) {
      try {
        const scoring = await scoreLead(lead);
        await query(
          `UPDATE leads SET lead_score = $1, score_reason = $2, score_updated_at = NOW() WHERE id = $3`,
          [scoring.score, scoring.reason, lead.id]
        );
        results.push({ id: lead.id, name: lead.name, ...scoring });
      } catch (e) {
        console.error(`Failed to score lead ${lead.id}:`, e.message);
      }
    }

    res.json({ message: `Scored ${results.length} leads`, results });
  } catch (error) {
    console.error('Bulk score error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/ai/summarize/:leadId - Get AI summary of a lead
const summarizeLeadById = async (req, res) => {
  try {
    const leadResult = await query(
      'SELECT * FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.leadId, req.tenantId]
    );
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const messagesResult = await query(
      `SELECT * FROM whatsapp_messages WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 20`,
      [req.params.leadId]
    );

    const activitiesResult = await query(
      `SELECT * FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [req.params.leadId]
    );

    const summary = await summarizeLead(leadResult.rows[0], messagesResult.rows.reverse(), activitiesResult.rows);
    res.json({ summary });
  } catch (error) {
    console.error('Summarize error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/ai/qualify - Test the qualification bot
const testQualify = async (req, res) => {
  try {
    const { leadName, message, businessContext } = req.body;
    if (!leadName || !message) return res.status(400).json({ error: 'leadName and message required.' });

    const result = await qualifyLead(leadName, [], message, businessContext || { business_name: req.user.tenant_name });
    res.json(result);
  } catch (error) {
    console.error('Qualify test error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

module.exports = { scoreLeadById, scoreBulkLeads, summarizeLeadById, testQualify };
