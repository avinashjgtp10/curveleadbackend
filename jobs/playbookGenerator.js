const { query } = require('../config/db');
const { generatePlaybook } = require('../services/groqService');

const MAX_PER_OUTCOME = 40;
const MIN_CALLS_REQUIRED = 5;

// Pulls completed, analyzed calls (human recordings + AI agent calls) whose
// lead is currently sitting in a won/lost stage, using the same *dynamic*
// is_won/is_lost lookup pattern as the dashboard summary report — not a
// hardcoded `stage = 'won'` string match, since stages are tenant-customizable.
const buildOutcomeQuery = (tenantId) => {
  const filter1 = tenantId ? 'AND c.tenant_id = $1' : '';
  const filter2 = tenantId ? 'AND v.tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];
  const sql = `
    (SELECT c.tenant_id, c.analysis, c.created_at,
            CASE WHEN ls.is_won THEN 'won' WHEN ls.is_lost THEN 'lost' END as outcome
     FROM call_recordings c
     JOIN leads l ON c.lead_id = l.id
     JOIN lead_stages ls ON LOWER(ls.name) = LOWER(l.stage) AND ls.tenant_id = l.tenant_id
     WHERE c.analysis IS NOT NULL AND c.analysis_status = 'done' AND (ls.is_won OR ls.is_lost) ${filter1}
     ORDER BY c.created_at DESC LIMIT 1000)
    UNION ALL
    (SELECT v.tenant_id, v.analysis, v.created_at,
            CASE WHEN ls.is_won THEN 'won' WHEN ls.is_lost THEN 'lost' END as outcome
     FROM ai_voice_calls v
     JOIN leads l ON v.lead_id = l.id
     JOIN lead_stages ls ON LOWER(ls.name) = LOWER(l.stage) AND ls.tenant_id = l.tenant_id
     WHERE v.analysis IS NOT NULL AND v.status = 'completed' AND (ls.is_won OR ls.is_lost) ${filter2}
     ORDER BY v.created_at DESC LIMIT 1000)
    ORDER BY created_at DESC
  `;
  return { sql, params };
};

// Groups raw rows into { tenantId: { won: [analysis...], lost: [analysis...] } },
// capping each side per tenant. Rows arrive ordered by created_at DESC, so the
// first MAX_PER_OUTCOME pushed per tenant/outcome are naturally the most recent.
const groupByTenant = (rows) => {
  const grouped = {};
  for (const row of rows) {
    if (!row.outcome) continue;
    const g = grouped[row.tenant_id] || (grouped[row.tenant_id] = { won: [], lost: [] });
    if (g[row.outcome].length < MAX_PER_OUTCOME) g[row.outcome].push(row.analysis);
  }
  return grouped;
};

const insertPlaybookVersion = async (tenantId, playbook, wonCount, lostCount) => {
  const versionRes = await query('SELECT COALESCE(MAX(version), 0) + 1 as v FROM sales_playbooks WHERE tenant_id=$1', [tenantId]);
  const version = versionRes.rows[0].v;
  const result = await query(
    `INSERT INTO sales_playbooks
       (tenant_id, version, best_practices, common_objections, phrases_that_work, phrases_to_avoid,
        source_call_count, source_won_count, source_lost_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      tenantId, version,
      JSON.stringify(playbook.best_practices || []),
      JSON.stringify(playbook.common_objections || []),
      JSON.stringify(playbook.phrases_that_work || []),
      JSON.stringify(playbook.phrases_to_avoid || []),
      wonCount + lostCount, wonCount, lostCount,
    ]
  );
  return result.rows[0];
};

// On-demand regeneration for a single tenant (used by POST /api/playbook/generate)
const generatePlaybookForTenant = async (tenantId) => {
  const { sql, params } = buildOutcomeQuery(tenantId);
  const result = await query(sql, params);
  const { won = [], lost = [] } = groupByTenant(result.rows)[tenantId] || {};

  if (won.length + lost.length < MIN_CALLS_REQUIRED) {
    return { skipped: true, reason: `Need at least ${MIN_CALLS_REQUIRED} won/lost calls with analysis (found ${won.length + lost.length}).` };
  }

  const playbook = await generatePlaybook({ wonSummaries: won, lostSummaries: lost });
  const row = await insertPlaybookVersion(tenantId, playbook, won.length, lost.length);
  return { skipped: false, playbook: row };
};

// Scheduled sweep across every tenant that currently has qualifying data
const runPlaybookGeneration = async () => {
  try {
    const { sql, params } = buildOutcomeQuery(null);
    const result = await query(sql, params);
    const grouped = groupByTenant(result.rows);

    let generated = 0;
    for (const [tenantId, { won, lost }] of Object.entries(grouped)) {
      if (won.length + lost.length < MIN_CALLS_REQUIRED) continue;
      try {
        const playbook = await generatePlaybook({ wonSummaries: won, lostSummaries: lost });
        await insertPlaybookVersion(tenantId, playbook, won.length, lost.length);
        generated++;
      } catch (e) {
        console.error(`[PlaybookJob] Failed for tenant ${tenantId}:`, e.message);
      }
    }

    if (generated > 0) console.log(`[PlaybookJob] Generated/updated playbooks for ${generated} tenant(s)`);
  } catch (e) {
    console.error('[PlaybookJob] Error:', e.message);
  }
};

module.exports = { runPlaybookGeneration, generatePlaybookForTenant };
