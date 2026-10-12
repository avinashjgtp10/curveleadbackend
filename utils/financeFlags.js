// Per-workspace switch for the payment ledger (tenants.settings.finance_ledger = 'on' | 'off', default off).
// Off: every finance endpoint answers 404 feature_off and legacy fields behave exactly as before.
// A global kill switch (FINANCE_LEDGER_KILL=1 in the process environment) turns it off for every workspace at once.
const { query } = require('../config/db');

const TTL_MS = 30 * 1000;
const cache = new Map();

const isOn = (value) => value === true || value === 'on' || value === 'true';

const ledgerEnabled = async (tenantId) => {
  if (process.env.FINANCE_LEDGER_KILL === '1') return false;
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
  let on = false;
  try {
    const r = await query(`SELECT settings->'finance_ledger' AS flag FROM tenants WHERE id = $1`, [tenantId]);
    const raw = r.rows[0] ? r.rows[0].flag : null;
    on = isOn(raw);
  } catch { on = false; } // unreadable settings means off, never on
  cache.set(tenantId, { on, at: Date.now() });
  return on;
};
const resetFinanceFlagCache = () => cache.clear();

// Express middleware: 404 when the ledger is off for this workspace.
const requireLedger = async (req, res, next) => {
  try {
    if (await ledgerEnabled(req.tenantId)) return next();
    res.status(404).json({ error: 'feature_off' });
  } catch (e) { res.status(404).json({ error: 'feature_off' }); }
};

module.exports = { ledgerEnabled, requireLedger, resetFinanceFlagCache, isOn };
