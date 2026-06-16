const express = require('express');
const router = express.Router();
const { verifyWebhook, receiveLeadFormWebhook } = require('../controllers/metaWebhookController');
const { receiveGoogleLead } = require('../controllers/googleWebhookController');
const { handleVoiceAiWebhook } = require('../controllers/voiceAiWebhookController');

router.get('/meta', verifyWebhook);
router.post('/meta', receiveLeadFormWebhook);
router.post('/google', receiveGoogleLead);
router.post('/voice-ai', handleVoiceAiWebhook);

module.exports = router;
