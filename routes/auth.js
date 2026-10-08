const express = require('express');
const router = express.Router();
const {
  signup, login, getProfile, forgotPassword, resetPassword, changePassword, getInviteInfo, acceptInvite,
  getPreferences, updatePreferences,
} = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

router.post('/signup', signup);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/invite/:token', getInviteInfo);
router.post('/accept-invite', acceptInvite);
router.get('/me', authenticate, getProfile);
router.post('/change-password', authenticate, changePassword);
router.get('/preferences', authenticate, getPreferences);
router.put('/preferences', authenticate, updatePreferences);

module.exports = router;
