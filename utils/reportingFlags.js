// Per-workspace mode for cohort reporting (tenants.settings.reporting_cohort = 'off' | 'shadow' | 'on', default off).
//   off     the cohort endpoints answer 404 feature_off and nothing else changes.
//   shadow  admins can request the cohort model; every request also computes the legacy figures and records the difference
//           in metric_shadow_log. Existing endpoints and screens are untouched.
//   on      the cohort model is available to everyone with finance.view.
// REPORTING_COHORT_KILL=1 in the process environment forces 'off' for every workspace at once.
const { query } = require('../config/db');

const MODES = ['off', 'shadow', 'on'];
const TTL_MS = 30 * 1000;
const cache = new Map();

const reportingMode = async (tenantId) => {
  if (process.env.REPORTING_COHORT_KILL === '1') return 'off';
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.mode;
  let mode = 'off';
  try {
    const raw = (await query(`SELECT settings->>'reporting_cohort' AS m FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.m;
    if (MODES.includes(raw)) mode = raw;
  } catch { mode = 'off'; } // unreadable settings mean off, never on
  cache.set(tenantId, { mode, at: Date.now() });
  return mode;
};
const resetReportingFlagCache = () => cache.clear();

module.exports = { reportingMode, resetReportingFlagCache, MODES };
