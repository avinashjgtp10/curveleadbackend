const express = require('express');
const router = express.Router();
const { verifyWebhook, receiveLeadFormWebhook, receiveWhatsAppWebhook } = require('../controllers/metaWebhookController');

// These are public endpoints - Meta sends webhooks here
router.get('/meta', verifyWebhook);
router.post('/meta', receiveLeadFormWebhook);
router.post('/meta/whatsapp', receiveWhatsAppWebhook);

module.exports = router;
