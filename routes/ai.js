const express = require('express');
const router = express.Router();
const { scoreLeadById, scoreBulkLeads, summarizeLeadById, testQualify } = require('../controllers/aiController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.post('/score-lead/:id', scoreLeadById);
router.post('/score-bulk', scoreBulkLeads);
router.post('/summarize/:leadId', summarizeLeadById);
router.post('/qualify', testQualify);

module.exports = router;
