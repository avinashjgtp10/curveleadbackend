const express = require('express');
const router = express.Router();
const { submitLead, listLeads, getLeadStatus, searchBusiness, getBusinessReport } = require('../controllers/gbpReportController');
const { authenticate, superAdminOnly } = require('../middleware/auth');

// Public — the landing page widget has no logged-in user.
router.post('/', submitLead);
router.get('/search-business', searchBusiness);
router.get('/business-report', getBusinessReport);
router.get('/:id/status', getLeadStatus);

// Internal — CurveLead's own team reviewing captured leads.
router.get('/', authenticate, superAdminOnly, listLeads);

module.exports = router;
