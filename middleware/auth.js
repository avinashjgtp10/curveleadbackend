const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch user with tenant info
    const result = await query(
      `SELECT u.id, u.name, u.email, u.role, u.tenant_id, u.is_active,
              t.name as tenant_name, t.business_type, t.subscription_status, t.trial_ends_at,
              t.subscription_start, t.subscription_end, p.name as plan_name
       FROM users u
       LEFT JOIN tenants t ON u.tenant_id = t.id
       LEFT JOIN plans p ON t.plan_id = p.id
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found.' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is inactive.' });
    }

    // Check subscription
    const isSubscriptionBypassRoute = ['/api/auth', '/api/payments'].includes(req.baseUrl);
    if (!isSubscriptionBypassRoute && user.subscription_status === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) < new Date()) {
      return res.status(402).json({ error: 'Trial expired. Please upgrade your plan.' });
    }

    req.user = user;
    req.tenantId = user.tenant_id;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please login again.' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token.' });
    }
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Authentication failed.' });
  }
};

const adminOnly = (req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

const superAdminOnly = (req, res, next) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required.' });
  }
  next();
};

module.exports = { authenticate, adminOnly, superAdminOnly };
