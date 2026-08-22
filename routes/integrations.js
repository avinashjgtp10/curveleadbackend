const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/integrationController');
const googleAdsCtrl = require('../controllers/googleAdsIntegrationController');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { tenantContext } = require('../middleware/tenant');

// Public routes — auth handled inside the controller, not via middleware
router.post('/ingest', ctrl.ingestLead);
router.post('/google-ads/leads/:integrationId', googleAdsCtrl.receiveGoogleAdsLead);

// Protected routes
router.use(authenticate, tenantContext, requirePermission('settings.manage'));
router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);
router.post('/api-key', ctrl.generateApiKey);
router.delete('/api-key', ctrl.revokeApiKey);
router.get('/embed-script', ctrl.getEmbedScript);

// Google Ads Lead Form integrations
router.get('/google-ads', googleAdsCtrl.listIntegrations);
router.post('/google-ads', googleAdsCtrl.createIntegration);
router.get('/google-ads/:id', googleAdsCtrl.getIntegration);
router.put('/google-ads/:id', googleAdsCtrl.updateIntegration);
router.post('/google-ads/:id/regenerate-key', googleAdsCtrl.regenerateKey);
router.get('/google-ads/:id/reveal-key', googleAdsCtrl.revealKey);
router.delete('/google-ads/:id/test-leads', googleAdsCtrl.deleteTestLeads);
router.delete('/google-ads/:id', googleAdsCtrl.deleteIntegration);

// Facebook OAuth flow
router.post('/facebook/auth', ctrl.facebookAuth);
router.post('/facebook/connect-page', ctrl.facebookConnectPage);
router.post('/facebook/sync-leads', ctrl.facebookSyncLeads);
router.post('/facebook/subscribe-webhook', ctrl.facebookSubscribeWebhook);
router.get('/facebook/subscription-status', ctrl.facebookSubscriptionStatus);
router.get('/facebook/ad-accounts', ctrl.getAdAccounts);
router.post('/facebook/sync-ad-insights', ctrl.syncAdInsightsNow);
router.get('/meta/capi-stats', ctrl.getCapiStats);

module.exports = router;
