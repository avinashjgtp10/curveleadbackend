const express = require('express');
const router = express.Router();
const { signup, login, getProfile, forgotPassword, resetPassword, changePassword, getInviteInfo, acceptInvite } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

router.post('/signup', signup);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/invite/:token', getInviteInfo);
router.post('/accept-invite', acceptInvite);
router.get('/me', authenticate, getProfile);
router.post('/change-password', authenticate, changePassword);

module.exports = router;
