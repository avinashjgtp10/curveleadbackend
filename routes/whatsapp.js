const express = require('express');
const router = express.Router();
const { getInbox, getConversation, sendMessage, handleWebhook } = require('../controllers/whatsappController');
const { getBroadcastTemplates, createBroadcastTemplate, sendBroadcast } = require('../controllers/whatsappBroadcastController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

// Webhook (no auth - public for WhatsApp Business)
router.get('/webhook', handleWebhook);
router.post('/webhook', handleWebhook);

// Protected routes
router.use(authenticate, tenantContext);
router.get('/inbox', getInbox);
router.get('/conversation/:leadId', getConversation);
router.post('/send', sendMessage);
router.get('/broadcast/templates', requirePermission('settings.manage'), getBroadcastTemplates);
router.post('/broadcast/templates', requirePermission('settings.manage'), createBroadcastTemplate);
router.post('/broadcast/send', requirePermission('leads.bulk_edit'), sendBroadcast);

module.exports = router;
