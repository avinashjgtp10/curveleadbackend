const express = require('express');
const router = express.Router();
const { getLeads, getLead, createLead, updateLead, deleteLead, addNote, addFollowup, getStages, getTodayFollowups, bulkUpdate, bulkDelete } = require('../controllers/leadController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/stages/all', getStages);
router.get('/followups/today', getTodayFollowups);
router.put('/bulk', bulkUpdate);
router.delete('/bulk', adminOnly, bulkDelete);
router.get('/', getLeads);
router.get('/:id', getLead);
router.post('/', checkPlanLimit('max_leads'), createLead);
router.put('/:id', updateLead);
router.delete('/:id', adminOnly, deleteLead);
router.post('/:id/note', addNote);
router.post('/:id/followups', addFollowup);

module.exports = router;
