const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/automationController');
const assignCtrl = require('../controllers/assignmentRuleController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

router.use(authenticate, tenantContext);

router.get('/sequences', ctrl.getSequences);
router.post('/sequences', requirePermission('automations.manage'), ctrl.createSequence);
router.put('/sequences/:id', requirePermission('automations.manage'), ctrl.updateSequence);
router.delete('/sequences/:id', requirePermission('automations.manage'), ctrl.deleteSequence);

router.get('/rules', ctrl.getRules);
router.post('/rules', requirePermission('automations.manage'), ctrl.createRule);
router.put('/rules/:id', requirePermission('automations.manage'), ctrl.updateRule);
router.delete('/rules/:id', requirePermission('automations.manage'), ctrl.deleteRule);

router.get('/assignment-rules', assignCtrl.getAssignmentRules);
router.post('/assignment-rules', requirePermission('automations.manage'), assignCtrl.createAssignmentRule);
router.put('/assignment-rules/reorder', requirePermission('automations.manage'), assignCtrl.reorderAssignmentRules);
router.put('/assignment-rules/:id', requirePermission('automations.manage'), assignCtrl.updateAssignmentRule);
router.delete('/assignment-rules/:id', requirePermission('automations.manage'), assignCtrl.deleteAssignmentRule);

module.exports = router;
