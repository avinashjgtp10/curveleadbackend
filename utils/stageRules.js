const { query } = require('../config/db');

// Guards on stage flags (Batch 1 A). "Won" drives every converted / revenue / cost-per-customer
// number, so: a stage can't be both won and lost, and the first pipeline stage (where new
// leads land) can't be won — that would count every new lead as a customer.
const stageFlagError = ({ isWon, isLost, isFirst }) => {
  if (isWon && isLost) return 'A stage can be won or lost, not both.';
  if (isWon && isFirst) return "The first stage is where new leads start, so it can't be a won stage. Mark the stage where a lead becomes a customer instead.";
  return null;
};

// For an existing stage: its final flags after the update, and whether it's the first stage.
const checkStageUpdate = async ({ tenantId, stageId, isWon, isLost }) => {
  const r = (await query(
    `SELECT s.is_won, s.is_lost,
            COALESCE(s.pos, s.position) <= (SELECT min(COALESCE(x.pos, x.position)) FROM lead_stages x WHERE x.tenant_id = s.tenant_id AND COALESCE(x.is_active, true)) AS is_first
     FROM lead_stages s WHERE s.id = $1 AND s.tenant_id = $2`, [stageId, tenantId])).rows[0];
  if (!r) return null;
  return stageFlagError({ isWon: isWon ?? r.is_won, isLost: isLost ?? r.is_lost, isFirst: r.is_first });
};

// ---- Phase 1 stage integrity -----------------------------------------------------------------------------
// Conversion numbers match leads and history to a stage by NAME, so these guards stop an edit from silently
// orphaning data. Everything here is a refusal with an explanation, never a rewrite of existing data.
const MAX_STAGE_NAME = 50; // leads.stage is VARCHAR(50)
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Name rules shared by create and rename. Returns an error message or null.
const stageNameError = (name) => {
  const n = String(name == null ? '' : name).trim();
  if (!n) return 'Stage name is required.';
  if (n.length > MAX_STAGE_NAME) return `Stage names can be at most ${MAX_STAGE_NAME} characters.`;
  return null;
};

// How much data refers to a stage by name: leads (merged ones too) and audit history.
const stageUsage = async ({ tenantId, name }) => {
  const r = (await query(
    `SELECT (SELECT count(*)::int FROM leads WHERE tenant_id = $1 AND lower(trim(stage)) = lower(trim($2))) AS leads,
            (SELECT count(*)::int FROM lead_stage_history WHERE tenant_id = $1 AND (lower(trim(new_stage)) = lower(trim($2)) OR lower(trim(prev_stage)) = lower(trim($2)))) AS history`,
    [tenantId, name])).rows[0] || {};
  return { leads: Number(r.leads) || 0, history: Number(r.history) || 0 };
};

const usageText = (u) => `${plural(u.leads, 'lead')} and ${u.history} history ${u.history === 1 ? 'entry' : 'entries'}`;

// Another stage of this workspace with the same name (ignoring case and spacing).
const duplicateStageName = async ({ tenantId, name, exceptId = null }) => (await query(
  `SELECT id FROM lead_stages WHERE tenant_id = $1 AND lower(trim(name)) = lower(trim($2)) AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
  [tenantId, name, exceptId])).rows.length > 0;

// Everything an UPDATE of a stage must satisfy. `patch` has name / is_active / is_won / is_lost (undefined = unchanged).
// Returns { error, status } to refuse, or { warnings } (possibly empty) to allow.
const checkStageEdit = async ({ tenantId, stageId, patch }) => {
  const cur = (await query(
    'SELECT id, name, is_won, is_lost, COALESCE(is_active, true) AS is_active FROM lead_stages WHERE id = $1 AND tenant_id = $2', [stageId, tenantId])).rows[0];
  if (!cur) return { error: 'Stage not found.', status: 404 };
  const warnings = [];

  if (patch.name !== undefined && patch.name !== null) {
    const nameError = stageNameError(patch.name);
    if (nameError) return { error: nameError, status: 422 };
    if (norm(patch.name) !== norm(cur.name)) {
      if (await duplicateStageName({ tenantId, name: patch.name, exceptId: stageId })) return { error: 'A stage with this name already exists.', status: 409 };
      const used = await stageUsage({ tenantId, name: cur.name });
      if (used.leads || used.history) {
        return { status: 422, error: `"${cur.name}" is used by ${usageText(used)}. Renaming it would drop them from conversion and revenue reports. Add a new stage and move the leads instead, or keep this name.` };
      }
    } // a change of letter case only is safe: every report matches names case-insensitively
  }

  const becomesInactive = patch.is_active === false && cur.is_active;
  const losesWon = patch.is_won === false && cur.is_won;
  if ((becomesInactive || losesWon) && cur.is_won) {
    const others = (await query(
      `SELECT count(*)::int AS n FROM lead_stages WHERE tenant_id = $1 AND id <> $2 AND is_won AND COALESCE(is_active, true)`, [tenantId, stageId])).rows[0].n;
    if (!others) {
      const used = await stageUsage({ tenantId, name: cur.name });
      if (used.leads || used.history) return { status: 422, error: `This is the workspace's only active won stage and ${usageText(used)} refer to it. Mark another stage as won first.` };
    }
  }

  if ((patch.is_won !== undefined && patch.is_won !== null && !!patch.is_won !== !!cur.is_won)
    || (patch.is_lost !== undefined && patch.is_lost !== null && !!patch.is_lost !== !!cur.is_lost)) {
    const used = await stageUsage({ tenantId, name: cur.name });
    if (used.leads || used.history) warnings.push(`Changing the won/lost flag recalculates conversions for ${usageText(used)}.`);
  }
  return { warnings };
};

// A stage may only be deleted when nothing refers to it; otherwise deactivate it.
const checkStageDelete = async ({ tenantId, stageId }) => {
  const cur = (await query('SELECT name, is_won FROM lead_stages WHERE id = $1 AND tenant_id = $2', [stageId, tenantId])).rows[0];
  if (!cur) return { error: 'Stage not found.', status: 404 };
  const used = await stageUsage({ tenantId, name: cur.name });
  if (used.leads || used.history) return { status: 409, error: `"${cur.name}" is used by ${usageText(used)} and can't be deleted. Mark it inactive instead, so history stays intact.` };
  return {};
};

module.exports = { stageFlagError, checkStageUpdate, MAX_STAGE_NAME, stageNameError, stageUsage, duplicateStageName, checkStageEdit, checkStageDelete };
