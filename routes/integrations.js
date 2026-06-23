const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/integrationController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

// Public route — API key auth handled inside controller
router.post('/ingest', ctrl.ingestLead);

// Protected routes
router.use(authenticate, tenantContext, adminOnly);
router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);
router.post('/api-key', ctrl.generateApiKey);
router.delete('/api-key', ctrl.revokeApiKey);
router.get('/embed-script', ctrl.getEmbedScript);

// Facebook OAuth flow
router.post('/facebook/auth', ctrl.facebookAuth);
router.post('/facebook/connect-page', ctrl.facebookConnectPage);
router.post('/facebook/sync-leads', ctrl.facebookSyncLeads);
router.post('/facebook/subscribe-webhook', ctrl.facebookSubscribeWebhook);
router.get('/facebook/subscription-status', ctrl.facebookSubscriptionStatus);

module.exports = router;
