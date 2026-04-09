const { query } = require('../config/db');

// Ensure tenant context is set on every request
// This middleware runs after authenticate
const tenantContext = (req, res, next) => {
  if (!req.user || !req.user.tenantId) {
    return res.status(400).json({ error: 'Tenant context not found.' });
  }
  // Attach tenantId for easy access in controllers
  req.tenantId = req.user.tenantId;
  next();
};

// Check plan limits before allowing certain actions
const checkPlanLimit = (limitField) => {
  return async (req, res, next) => {
    try {
      // Get current plan limits
      const planResult = await query(
        `SELECT p.* FROM plans p
         JOIN tenants t ON t.plan_id = p.id
         WHERE t.id = $1`,
        [req.tenantId]
      );

      if (planResult.rows.length === 0) {
        return res.status(400).json({ error: 'No active plan found.' });
      }

      const plan = planResult.rows[0];
      const limit = plan[limitField];

      // -1 means unlimited
      if (limit === -1) {
        return next();
      }

      // Check current count based on limit field
      let countQuery;
      switch (limitField) {
        case 'max_leads':
          // Count leads this month
          countQuery = await query(
            `SELECT COUNT(*) FROM leads 
             WHERE tenant_id = $1 
             AND created_at >= date_trunc('month', CURRENT_DATE)`,
            [req.tenantId]
          );
          break;
        case 'max_students':
          countQuery = await query(
            `SELECT COUNT(*) FROM students WHERE tenant_id = $1 AND status = 'active'`,
            [req.tenantId]
          );
          break;
        case 'max_staff':
          countQuery = await query(
            `SELECT COUNT(*) FROM users WHERE tenant_id = $1 AND role = 'staff' AND is_active = true`,
            [req.tenantId]
          );
          break;
        case 'max_courses':
          countQuery = await query(
            `SELECT COUNT(*) FROM courses WHERE tenant_id = $1 AND is_active = true`,
            [req.tenantId]
          );
          break;
        default:
          return next();
      }

      const currentCount = parseInt(countQuery.rows[0].count);

      if (currentCount >= limit) {
        return res.status(403).json({
          error: `Plan limit reached. Your ${plan.name} plan allows ${limit} ${limitField.replace('max_', '')}. Please upgrade your plan.`,
          current: currentCount,
          limit: limit,
          plan: plan.name
        });
      }

      next();
    } catch (error) {
      console.error('Plan limit check error:', error);
      next(); // Don't block on errors, let the request through
    }
  };
};

// Check if a specific feature is enabled in the plan
const requireFeature = (featureField) => {
  return async (req, res, next) => {
    try {
      const planResult = await query(
        `SELECT p.* FROM plans p
         JOIN tenants t ON t.plan_id = p.id
         WHERE t.id = $1`,
        [req.tenantId]
      );

      if (planResult.rows.length === 0) {
        return res.status(400).json({ error: 'No active plan found.' });
      }

      const plan = planResult.rows[0];

      if (!plan[featureField]) {
        return res.status(403).json({
          error: `This feature is not available in your ${plan.name} plan. Please upgrade to access it.`,
          feature: featureField,
          plan: plan.name
        });
      }

      next();
    } catch (error) {
      console.error('Feature check error:', error);
      next();
    }
  };
};

module.exports = { tenantContext, checkPlanLimit, requireFeature };
