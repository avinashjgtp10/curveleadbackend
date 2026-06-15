const express = require('express');
const router = express.Router();
const { scoreLeadById, scoreBulkLeads, summarizeLeadById, testQualify, runMarketAnalysis } = require('../controllers/aiController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.post('/score-lead/:id', scoreLeadById);
router.post('/score-bulk', scoreBulkLeads);
router.post('/summarize/:leadId', summarizeLeadById);
router.post('/qualify', testQualify);
router.post('/market-analysis', runMarketAnalysis);

module.exports = router;
