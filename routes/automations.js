const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/automationController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/sequences', ctrl.getSequences);
router.post('/sequences', adminOnly, ctrl.createSequence);
router.put('/sequences/:id', adminOnly, ctrl.updateSequence);
router.delete('/sequences/:id', adminOnly, ctrl.deleteSequence);

router.get('/rules', ctrl.getRules);
router.post('/rules', adminOnly, ctrl.createRule);
router.put('/rules/:id', adminOnly, ctrl.updateRule);
router.delete('/rules/:id', adminOnly, ctrl.deleteRule);

module.exports = router;
