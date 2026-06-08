const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, transaction } = require('../config/db');

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// POST /api/auth/signup
const signup = async (req, res) => {
  try {
    const { businessName, name, email, phone, password, businessType } = req.body;

    if (!businessName || !name || !email || !password) {
      return res.status(400).json({ error: 'Business name, name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered.' });
    }

    let slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const slugCheck = await query('SELECT id FROM tenants WHERE slug = $1', [slug]);
    if (slugCheck.rows.length > 0) slug = `${slug}-${Date.now().toString(36)}`;

    const planResult = await query("SELECT id FROM plans WHERE name = 'Free' LIMIT 1");
    const planId = planResult.rows[0]?.id;

    const passwordHash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14);

    const result = await transaction(async (client) => {
      const tenantResult = await client.query(
        `INSERT INTO tenants (name, slug, email, phone, business_type, plan_id, subscription_status, trial_ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'trial', $7)
         RETURNING id, name, slug, business_type`,
        [businessName, slug, email, phone, businessType || 'lead_management', planId, trialEndsAt]
      );
      const tenant = tenantResult.rows[0];

      const userResult = await client.query(
        `INSERT INTO users (tenant_id, name, email, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, 'admin')
         RETURNING id, name, email, role, tenant_id`,
        [tenant.id, name, email, phone, passwordHash]
      );

      // Create default lead stages
      const defaultStages = [
        { name: 'New', pos: 1, color: 'blue' },
        { name: 'Contacted', pos: 2, color: 'yellow' },
        { name: 'Qualified', pos: 3, color: 'purple' },
        { name: 'Proposal', pos: 4, color: 'orange' },
        { name: 'Won', pos: 5, color: 'green', is_won: true },
        { name: 'Lost', pos: 6, color: 'red', is_lost: true },
      ];

      for (const stage of defaultStages) {
        await client.query(
          `INSERT INTO lead_stages (tenant_id, name, pos, color, is_won, is_lost)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tenant.id, stage.name, stage.pos, stage.color, stage.is_won || false, stage.is_lost || false]
        );
      }

      return { user: userResult.rows[0], tenant };
    });

    const token = generateToken(result.user.id);
    res.status(201).json({
      message: 'Account created! 14-day free trial started.',
      token,
      user: result.user,
      tenant: result.tenant,
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Signup failed.' });
  }
};

// POST /api/auth/login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const result = await query(
      `SELECT u.id, u.name, u.email, u.role, u.tenant_id, u.is_active, u.password_hash,
              t.name as tenant_name, t.slug, t.business_type, t.subscription_status, t.trial_ends_at,
              t.subscription_start, t.subscription_end, p.name as plan_name
       FROM users u LEFT JOIN tenants t ON u.tenant_id = t.id
       LEFT JOIN plans p ON t.plan_id = p.id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = result.rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Account inactive.' });

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials.' });

    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = generateToken(user.id);
    delete user.password_hash;

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role, tenant_id: user.tenant_id,
      },
      tenant: {
        id: user.tenant_id, name: user.tenant_name, slug: user.slug, business_type: user.business_type,
        subscriptionStatus: user.subscription_status, trialEndsAt: user.trial_ends_at,
        subscriptionStart: user.subscription_start, subscriptionEnd: user.subscription_end,
        planName: user.plan_name,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
};

// GET /api/auth/me
const getProfile = async (req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
    tenant: {
      id: req.user.tenant_id, name: req.user.tenant_name, business_type: req.user.business_type,
      subscriptionStatus: req.user.subscription_status, trialEndsAt: req.user.trial_ends_at,
      subscriptionStart: req.user.subscription_start, subscriptionEnd: req.user.subscription_end,
      planName: req.user.plan_name,
    },
  });
};

// POST /api/auth/forgot-password
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const userResult = await query('SELECT id, name, email FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.json({ message: 'If account exists, reset link has been sent.' });
    }

    const user = userResult.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await query('UPDATE password_reset_tokens SET used = true WHERE user_id = $1', [user.id]);
    await query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
    console.log(`🔑 Password Reset URL for ${email}:\n${resetUrl}\n`);

    // Send email (if configured)
    try {
      const { sendPasswordResetEmail } = require('../utils/email');
      await sendPasswordResetEmail(email, resetUrl, 'CurveLead');
    } catch (e) {
      console.error('Email send failed:', e.message);
    }

    res.json({ message: 'If account exists, reset link has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/auth/reset-password
const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const tokenResult = await query(
      'SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = $1',
      [token]
    );
    if (tokenResult.rows.length === 0) return res.status(400).json({ error: 'Invalid token.' });

    const resetToken = tokenResult.rows[0];
    if (resetToken.used) return res.status(400).json({ error: 'Token already used.' });
    if (new Date(resetToken.expires_at) < new Date()) return res.status(400).json({ error: 'Token expired.' });

    const passwordHash = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetToken.user_id]);
    await query('UPDATE password_reset_tokens SET used = true WHERE token = $1', [token]);

    res.json({ message: 'Password reset successful.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/auth/change-password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect.' });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, req.user.id]);

    res.json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

module.exports = { signup, login, getProfile, forgotPassword, resetPassword, changePassword };
