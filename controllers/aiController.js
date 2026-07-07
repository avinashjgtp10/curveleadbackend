const { query } = require('../config/db');
const { qualifyLead, summarizeLead, analyzeMarket } = require('../services/groqService');
const { computeFollowupHealth } = require('../utils/followupHealth');
const { computeIntentScore } = require('../services/intentScoring');

// Gathers the deterministic inputs computeIntentScore needs for one lead —
// pending follow-up + rollover count from recent lead_followups, and the
// lead's current stage won/lost flags.
const gatherIntentInputs = async (lead, tenantId) => {
  const [followupsResult, stageResult] = await Promise.all([
    query(
      `SELECT next_followup_at, is_completed, outcome FROM lead_followups
       WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [lead.id]
    ),
    query(
      `SELECT is_won, is_lost FROM lead_stages
       WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [tenantId, lead.stage]
    ),
  ]);

  const recent = followupsResult.rows;
  const pendingFollowup = recent.find(f => !f.is_completed) || null;
  const rolloverCount = recent.filter(f => f.is_completed && !f.outcome).length;
  const followupHealth = computeFollowupHealth(pendingFollowup);
  const stage = stageResult.rows[0] || {};

  return { followupHealth, rolloverCount, isWon: !!stage.is_won, isLost: !!stage.is_lost };
};

// POST /api/ai/score-lead/:id - Recalculate a single lead's intent score
const scoreLeadById = async (req, res) => {
  try {
    const leadResult = await query(
      'SELECT * FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (leadResult.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const lead = leadResult.rows[0];
    const inputs = await gatherIntentInputs(lead, req.tenantId);
    const scoring = computeIntentScore({ lead, ...inputs });

    // Update lead
    await query(
      `UPDATE leads SET lead_score = $1, score_reason = $2, score_updated_at = NOW(),
              intent_score = $3, suggested_action = $4
       WHERE id = $5 AND tenant_id = $6`,
      [scoring.score, scoring.reason, scoring.intent_score, scoring.suggested_action, req.params.id, req.tenantId]
    );

    // Log activity
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1, $2, 'score_change', $3, $4, $5)`,
      [req.tenantId, req.params.id, `Scored ${scoring.intent_score}/100 (${scoring.score})`, scoring.reason, req.user.id]
    );

    res.json({ scoring });
  } catch (error) {
    console.error('Score lead error:', error);
    res.status(500).json({ error: error.message || 'Failed to score lead.' });
  }
};

// POST /api/ai/score-bulk - Recalculate intent score for all stale leads
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
        const inputs = await gatherIntentInputs(lead, req.tenantId);
        const scoring = computeIntentScore({ lead, ...inputs });
        await query(
          `UPDATE leads SET lead_score = $1, score_reason = $2, score_updated_at = NOW(),
                  intent_score = $3, suggested_action = $4 WHERE id = $5`,
          [scoring.score, scoring.reason, scoring.intent_score, scoring.suggested_action, lead.id]
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

// POST /api/ai/market-analysis
const runMarketAnalysis = async (req, res) => {
  try {
    const { business_name, industry, product_service, target_geography, customer_type } = req.body;
    if (!industry || !product_service) {
      return res.status(400).json({ error: 'industry and product_service are required.' });
    }
    const analysis = await analyzeMarket({
      business_name: business_name || 'My Business',
      industry,
      product_service,
      target_geography,
      customer_type,
    });
    res.json({ analysis });
  } catch (error) {
    console.error('Market analysis error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate analysis.' });
  }
};

module.exports = { scoreLeadById, scoreBulkLeads, summarizeLeadById, testQualify, runMarketAnalysis };
