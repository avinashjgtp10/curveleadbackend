const { query } = require('../config/db');
const { computeFollowupHealth } = require('../utils/followupHealth');
const { computeIntentScore } = require('./intentScoring');

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
    // is_first: a won tag on the entry stage (where new leads land) is a setup mistake, never a
    // closed deal — the same rule utils/stageRules.js enforces when stages are saved.
    query(
      `SELECT s.is_won, s.is_lost,
              COALESCE(s.pos, s.position) <= (SELECT min(COALESCE(x.pos, x.position)) FROM lead_stages x WHERE x.tenant_id = s.tenant_id AND COALESCE(x.is_active, true)) AS is_first
       FROM lead_stages s
       WHERE s.tenant_id = $1 AND LOWER(s.name) = LOWER($2) LIMIT 1`,
      [tenantId, lead.stage]
    ),
  ]);

  const recent = followupsResult.rows;
  const pendingFollowup = recent.find(f => !f.is_completed) || null;
  const rolloverCount = recent.filter(f => f.is_completed && !f.outcome).length;
  const followupHealth = computeFollowupHealth(pendingFollowup);
  const stage = stageResult.rows[0] || {};

  return { followupHealth, rolloverCount, isWon: !!stage.is_won && !stage.is_first, isLost: !!stage.is_lost };
};

// Scores a lead and stores the result (same as "Score lead" in the app), logging it on
// the lead's timeline. actorId null = done automatically.
const scoreAndSaveLead = async (lead, tenantId, actorId = null) => {
  const scoring = computeIntentScore({ lead, ...await gatherIntentInputs(lead, tenantId) });
  await query(
    `UPDATE leads SET lead_score = $1, score_reason = $2, score_updated_at = NOW(),
            intent_score = $3, suggested_action = $4
     WHERE id = $5 AND tenant_id = $6`,
    [scoring.score, scoring.reason, scoring.intent_score, scoring.suggested_action, lead.id, tenantId]
  );
  await query(
    `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
     VALUES ($1, $2, 'score_change', $3, $4, $5)`,
    [tenantId, lead.id, `Scored ${scoring.intent_score}/100 (${scoring.score})`, scoring.reason, actorId]
  );
  return scoring;
};

module.exports = { gatherIntentInputs, scoreAndSaveLead };
