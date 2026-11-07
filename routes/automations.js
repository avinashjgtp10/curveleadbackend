const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/automationController');
const assignCtrl = require('../controllers/assignmentRuleController');
const enrollCtrl = require('../controllers/automationEnrollmentController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');
const rateLimit = require('express-rate-limit');
const testSend = require('../controllers/automationTestSendController');

const multer = require('multer');
const { MAX_UPLOAD_BYTES } = require('../utils/sequenceMedia');
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

router.use(authenticate, tenantContext);

router.post('/media', requirePermission('automations.manage'), (req, res, next) => mediaUpload.single('file')(req, res, (err) => (err
  ? res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (16 MB at most).' : 'Upload failed.' })
  : next())), ctrl.uploadStepMedia);
// A test always goes to the signed-in user's own phone; keep it from being used as a message cannon.
const testSendLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.AUTOMATION_TEST_SEND_PER_MIN) || 5, keyGenerator: (req) => `autotest:${req.user?.id || req.ip}`, message: { error: 'Too many test messages. Wait a minute and try again.' } });
router.post('/test-send', requirePermission('automations.manage'), testSendLimiter, testSend.testSend);
router.get('/sequences', ctrl.getSequences);
router.post('/sequences', requirePermission('automations.manage'), ctrl.createSequence);
router.put('/sequences/:id', requirePermission('automations.manage'), ctrl.updateSequence);
router.delete('/sequences/:id', requirePermission('automations.manage'), ctrl.deleteSequence);

router.get('/rules', ctrl.getRules);
router.post('/rules', requirePermission('automations.manage'), ctrl.createRule);
router.put('/rules/:id', requirePermission('automations.manage'), ctrl.updateRule);
router.delete('/rules/:id', requirePermission('automations.manage'), ctrl.deleteRule);

router.get('/enrollments', enrollCtrl.getEnrollments);
router.post('/enrollments/query', enrollCtrl.getEnrollments);
router.get('/leads', enrollCtrl.getAutomationLeads);
router.post('/enrollments/:id/recover', requirePermission('automations.manage'), enrollCtrl.recoverEnrollment);
router.post('/enroll-bulk', requirePermission('leads.bulk_edit'), enrollCtrl.enrollBulk);

router.get('/assignment-rules', assignCtrl.getAssignmentRules);
router.post('/assignment-rules', requirePermission('automations.manage'), assignCtrl.createAssignmentRule);
router.put('/assignment-rules/reorder', requirePermission('automations.manage'), assignCtrl.reorderAssignmentRules);
router.put('/assignment-rules/:id', requirePermission('automations.manage'), assignCtrl.updateAssignmentRule);
router.delete('/assignment-rules/:id', requirePermission('automations.manage'), assignCtrl.deleteAssignmentRule);

module.exports = router;
