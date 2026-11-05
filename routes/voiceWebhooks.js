const express = require('express');
const router = express.Router();
const { telnyxWebhook } = require('../controllers/voiceCallingController');
// No login and no user rate limit: authenticity is the provider's Ed25519 signature + timestamp window.
router.post('/telnyx', telnyxWebhook);
module.exports = router;
