const express = require('express');
const router = express.Router();
const {
  signup, login, googleLogin, requestOtp, verifyOtp, getProfile, forgotPassword, resetPassword, changePassword, getInviteInfo, acceptInvite,
  getPreferences, updatePreferences,
} = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

// GET /google/start and /google/callback (Google redirect sign-in). Mounted here so /api/auth passes the
// rate limiter exactly once; the same router is also mounted at /api/v1/auth by authMounts.js.
router.use(require('./googleAuth'));
router.post('/signup', signup);
router.post('/login', login);
router.post('/google', googleLogin);
router.post('/request-otp', requestOtp);
router.post('/verify-otp', verifyOtp);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/invite/:token', getInviteInfo);
router.post('/accept-invite', acceptInvite);
router.get('/me', authenticate, getProfile);
router.post('/change-password', authenticate, changePassword);
router.get('/preferences', authenticate, getPreferences);
router.put('/preferences', authenticate, updatePreferences);

module.exports = router;
