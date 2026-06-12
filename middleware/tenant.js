const { query } = require('../config/db');

const tenantContext = (req, res, next) => {
  if (!req.tenantId) {
    return res.status(400).json({ error: 'Tenant context required.' });
  }
  next();
};

// Check plan limits before allowing creation
const checkPlanLimit = (limitField) => async (req, res, next) => {
  try {
    const result = await query(
      `SELECT p.max_leads, p.max_staff FROM plans p
       JOIN tenants t ON t.plan_id = p.id WHERE t.id = $1`,
      [req.tenantId]
    );

    if (result.rows.length === 0) return next();

    const plan = result.rows[0];

    if (limitField === 'max_leads' && plan.max_leads > 0) {
      const count = await query('SELECT COUNT(*) FROM leads WHERE tenant_id = $1', [req.tenantId]);
      if (parseInt(count.rows[0].count) >= plan.max_leads) {
        return res.status(403).json({
          error: `Lead limit reached (${plan.max_leads}). Please upgrade your plan.`,
        });
      }
    }

    if (limitField === 'max_staff' && plan.max_staff > 0) {
      const count = await query('SELECT COUNT(*) FROM users WHERE tenant_id = $1', [req.tenantId]);
      if (parseInt(count.rows[0].count) >= plan.max_staff) {
        return res.status(403).json({
          error: `Team member limit reached (${plan.max_staff}). Please upgrade your plan.`,
        });
      }
    }

    next();
  } catch (error) {
    console.error('Plan limit check error:', error);
    next(); // Don't block on errors
  }
};

module.exports = { tenantContext, checkPlanLimit };
