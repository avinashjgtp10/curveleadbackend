const express = require('express');
const router = express.Router();
const { getInbox, getConversation, sendMessage, handleWebhook } = require('../controllers/whatsappController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

// Webhook (no auth - public for WhatsApp Business)
router.get('/webhook', handleWebhook);
router.post('/webhook', handleWebhook);

// Protected routes
router.use(authenticate, tenantContext);
router.get('/inbox', getInbox);
router.get('/conversation/:leadId', getConversation);
router.post('/send', sendMessage);

module.exports = router;
