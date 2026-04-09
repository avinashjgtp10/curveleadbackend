const express = require('express');
const router = express.Router();
const { signup, login, getProfile, inviteStaff, changePassword, forgotPassword, resetPassword } = require('../controllers/authController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');

// Public routes
router.post('/signup', signup);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// Protected routes
router.get('/me', authenticate, getProfile);
router.put('/change-password', authenticate, changePassword);

// Admin only
router.post('/invite-staff', authenticate, tenantContext, adminOnly, checkPlanLimit('max_staff'), inviteStaff);

module.exports = router;
