const express = require('express');
const router = express.Router();
const { 
  getLeads, getLead, createLead, updateLead, deleteLead, 
  addFollowup, getLeadStats, getTodayFollowups, getLeadJourney, addActivity 
} = require('../controllers/leadController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');

// All routes require auth + tenant context
router.use(authenticate, tenantContext);

// Stats & follow-ups (must be before /:id routes)
router.get('/stats', getLeadStats);
router.get('/followups/today', getTodayFollowups);

// CRUD
router.get('/', getLeads);
router.get('/:id', getLead);
router.post('/', checkPlanLimit('max_leads'), createLead);
router.put('/:id', updateLead);
router.delete('/:id', adminOnly, deleteLead);

// Follow-ups & Journey
router.post('/:id/followups', addFollowup);
router.get('/:id/journey', getLeadJourney);
router.post('/:id/activities', addActivity);

module.exports = router;
