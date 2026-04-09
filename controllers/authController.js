const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// POST /api/auth/signup - Register new academy
const signup = async (req, res) => {
  try {
    const { academyName, name, email, phone, password, academyType } = req.body;

    // Validation
    if (!academyName || !name || !email || !password) {
      return res.status(400).json({ error: 'Academy name, your name, email, and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Check if email already exists
    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Generate slug from academy name
    let slug = academyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const slugCheck = await query('SELECT id FROM tenants WHERE slug = $1', [slug]);
    if (slugCheck.rows.length > 0) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // Get Basic plan (default for new signups / trial)
    const planResult = await query("SELECT id FROM plans WHERE name = 'Basic' AND is_active = true LIMIT 1");
    const planId = planResult.rows[0]?.id;

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create tenant
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14); // 14-day trial

    const tenantResult = await query(
      `INSERT INTO tenants (name, slug, email, phone, academy_type, plan_id, subscription_status, trial_ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'trial', $7)
       RETURNING id, name, slug`,
      [academyName, slug, email, phone, academyType || 'Other', planId, trialEndsAt]
    );

    const tenant = tenantResult.rows[0];

    // Create admin user
    const userResult = await query(
      `INSERT INTO users (tenant_id, name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'admin')
       RETURNING id, name, email, role`,
      [tenant.id, name, email, phone, passwordHash]
    );

    const user = userResult.rows[0];

    // Create default expense categories
    const defaultCategories = ['Rent', 'Utilities', 'Products & Supplies', 'Marketing', 'Miscellaneous'];
    for (const cat of defaultCategories) {
      await query(
        'INSERT INTO expense_categories (tenant_id, name, is_default) VALUES ($1, $2, true)',
        [tenant.id, cat]
      );
    }

    // Generate token
    const token = generateToken(user.id);

    res.status(201).json({
      message: 'Academy registered successfully! Your 14-day free trial has started.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      },
      trialEndsAt: trialEndsAt.toISOString(),
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
};

// POST /api/auth/login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Find user
    const result = await query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.is_active,
              u.tenant_id, t.name as tenant_name, t.slug, t.subscription_status,
              t.trial_ends_at, t.logo_url, p.name as plan_name
       FROM users u
       JOIN tenants t ON u.tenant_id = t.id
       LEFT JOIN plans p ON t.plan_id = p.id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your admin.' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Check trial expiry
    if (user.subscription_status === 'trial' && new Date(user.trial_ends_at) < new Date()) {
      await query(
        "UPDATE tenants SET subscription_status = 'expired' WHERE id = $1",
        [user.tenant_id]
      );
      return res.status(403).json({
        error: 'Your free trial has expired. Please subscribe to continue.',
        subscription_status: 'expired'
      });
    }

    // Update last login
    await query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    // Generate token
    const token = generateToken(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      tenant: {
        id: user.tenant_id,
        name: user.tenant_name,
        slug: user.slug,
        logoUrl: user.logo_url,
        subscriptionStatus: user.subscription_status,
        planName: user.plan_name,
        trialEndsAt: user.trial_ends_at,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
};

// GET /api/auth/me - Get current user profile
const getProfile = async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at,
              t.id as tenant_id, t.name as tenant_name, t.slug, t.email as tenant_email,
              t.phone as tenant_phone, t.address, t.city, t.state, t.academy_type,
              t.logo_url, t.subscription_status, t.trial_ends_at,
              p.name as plan_name, p.price as plan_price
       FROM users u
       JOIN tenants t ON u.tenant_id = t.id
       LEFT JOIN plans p ON t.plan_id = p.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const data = result.rows[0];

    res.json({
      user: {
        id: data.id,
        name: data.name,
        email: data.email,
        phone: data.phone,
        role: data.role,
        createdAt: data.created_at,
      },
      tenant: {
        id: data.tenant_id,
        name: data.tenant_name,
        slug: data.slug,
        email: data.tenant_email,
        phone: data.tenant_phone,
        address: data.address,
        city: data.city,
        state: data.state,
        academyType: data.academy_type,
        logoUrl: data.logo_url,
        subscriptionStatus: data.subscription_status,
        trialEndsAt: data.trial_ends_at,
        planName: data.plan_name,
        planPrice: data.plan_price,
      },
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
};

// POST /api/auth/invite-staff - Invite staff member
const inviteStaff = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    // Check if email already exists in this tenant
    const existing = await query(
      'SELECT id FROM users WHERE email = $1 AND tenant_id = $2',
      [email, req.tenantId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'A user with this email already exists in your academy.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (tenant_id, name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'staff')
       RETURNING id, name, email, role`,
      [req.tenantId, name, email, phone, passwordHash]
    );

    res.status(201).json({
      message: 'Staff member added successfully.',
      user: result.rows[0],
    });
  } catch (error) {
    console.error('Invite staff error:', error);
    res.status(500).json({ error: 'Failed to add staff member.' });
  }
};

// PUT /api/auth/change-password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const isMatch = await bcrypt.compare(currentPassword, result.rows[0].password_hash);

    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password.' });
  }
};

// POST /api/auth/forgot-password
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    // Find user
    const result = await query(
      'SELECT id, name, email FROM users WHERE email = $1',
      [email]
    );

    // Always return success (don't reveal if email exists)
    if (result.rows.length === 0) {
      return res.json({ message: 'If an account with this email exists, a reset link has been sent.' });
    }

    const user = result.rows[0];

    // Generate reset token
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour expiry

    // Invalidate old tokens
    await query(
      'UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false',
      [user.id]
    );

    // Save new token
    await query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    // TODO: Send email with reset link
    // For now, log the reset URL
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
    console.log(`\n🔑 Password Reset Link for ${user.email}:\n${resetUrl}\n`);

    res.json({
      message: 'If an account with this email exists, a reset link has been sent.',
      // Remove this in production — only for testing
      ...(process.env.NODE_ENV === 'development' && { resetUrl, token })
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
};

// POST /api/auth/reset-password
const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Find valid token
    const tokenResult = await query(
      `SELECT * FROM password_reset_tokens 
       WHERE token = $1 AND used = false AND expires_at > CURRENT_TIMESTAMP`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const resetToken = tokenResult.rows[0];

    // Update password
    const passwordHash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetToken.user_id]);

    // Mark token as used
    await query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [resetToken.id]);

    res.json({ message: 'Password reset successfully. You can now login with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
};

module.exports = { signup, login, getProfile, inviteStaff, changePassword, forgotPassword, resetPassword };
