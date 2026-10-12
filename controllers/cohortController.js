const cohort = require('../services/cohortMetrics');
const { reportingMode } = require('../utils/reportingFlags');

// Cohort reporting API (Phase 1). Behind the workspace mode (off by default) and finance.view. Read-only.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAdmin = (u) => u && (u.role === 'admin' || u.role === 'super_admin');

const parseCampaigns = (v) => {
  if (v == null || v === '') return { ids: null };
  const ids = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length > 50 || ids.some((i) => !UUID.test(i))) return { error: 'campaign_id must be a comma-separated list of campaign ids (at most 50).' };
  return { ids };
};

const fail = (res, e) => {
  if (e && e.code === 'cohort_unavailable') return res.status(503).json({ error: e.message, code: e.code, missing: e.missing });
  if (e && e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
  console.error('Cohort error:', e && e.message);
  return res.status(500).json({ error: 'Failed. Please try again.' });
};

// GET /api/cohort/metrics?period=…|date_from&date_to&campaign_id=a,b
const metrics = async (req, res) => {
  try {
    const mode = await reportingMode(req.tenantId);
    if (mode === 'off') return res.status(404).json({ error: 'feature_off' });
    if (mode === 'shadow' && !isAdmin(req.user)) return res.status(403).json({ error: 'Cohort reporting is in preview for administrators only.' });
    const parsed = parseCampaigns(req.query.campaign_id);
    if (parsed.error) return res.status(422).json({ error: parsed.error });
    const { cohort: result, scope } = await cohort.getCohortMetrics(req, { campaignIds: parsed.ids });
    const body = { mode, ...result };
    if (mode === 'shadow') body.shadow = await cohort.recordShadow(scope, result);
    res.json(body);
  } catch (e) { fail(res, e); }
};

// GET /api/cohort/health (administrators): can the numbers be trusted yet?
const health = async (req, res) => {
  try {
    const mode = await reportingMode(req.tenantId);
    if (mode === 'off') return res.status(404).json({ error: 'feature_off' });
    res.json({ mode, ...(await cohort.getHealth(req.tenantId)) });
  } catch (e) { fail(res, e); }
};

module.exports = { metrics, health, parseCampaigns };
