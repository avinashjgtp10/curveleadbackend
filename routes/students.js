const express = require('express');
const router = express.Router();
const { getStudents, getStudent, createStudent, updateStudent, enrollLead } = require('../controllers/studentController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getStudents);
router.get('/:id', getStudent);
router.post('/', checkPlanLimit('max_students'), createStudent);
router.put('/:id', updateStudent);
router.post('/enroll-lead/:leadId', checkPlanLimit('max_students'), enrollLead);

module.exports = router;
