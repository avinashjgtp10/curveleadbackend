// Google redirect sign-in. Mounted at /api/auth and /api/v1/auth (GOOGLE_REDIRECT_URI uses the /api/v1 path).
const express = require('express');
const { googleStart, googleCallback } = require('../controllers/authController');

const router = express.Router();
router.get('/google/start', googleStart);
router.get('/google/callback', googleCallback);

module.exports = router;
