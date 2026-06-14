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

module.exports = router;
