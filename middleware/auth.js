const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// Verify JWT token and attach user + tenant to request
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch user with tenant info
    const result = await query(
      `SELECT u.id, u.name, u.email, u.role, u.tenant_id, u.is_active,
              t.name as tenant_name, t.subscription_status, t.plan_id
       FROM users u
       JOIN tenants t ON u.tenant_id = t.id
       WHERE u.id = $1`,
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found.' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated.' });
    }

    // Check tenant status
    if (user.role !== 'super_admin' && !['active', 'trial'].includes(user.subscription_status)) {
      return res.status(403).json({ 
        error: 'Subscription inactive. Please renew your subscription.',
        subscription_status: user.subscription_status
      });
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id,
      tenantName: user.tenant_name,
      subscriptionStatus: user.subscription_status,
      planId: user.plan_id,
    };

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

// Role-based access control
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
};

// Super admin only
const superAdminOnly = (req, res, next) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required.' });
  }
  next();
};

// Admin only (academy admin)
const adminOnly = (req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

module.exports = { authenticate, authorize, superAdminOnly, adminOnly };
