const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const {
  getSettings, updateSettings, getVoices,
  listAgents, createAgent, updateAgent, deleteAgent,
  callLead, getLeadCalls, getCall,
} = require('../controllers/aiCallingController');

router.use(authenticate, tenantContext);

router.get('/settings', adminOnly, getSettings);
router.put('/settings', adminOnly, updateSettings);

router.get('/voices', getVoices);

router.get('/agents', listAgents);
router.post('/agents', adminOnly, createAgent);
router.put('/agents/:id', adminOnly, updateAgent);
router.delete('/agents/:id', adminOnly, deleteAgent);

router.get('/leads/:leadId/calls', getLeadCalls);
router.post('/leads/:leadId/call', callLead);
router.get('/calls/:id', getCall);

module.exports = router;
