const express = require('express');
const router = express.Router();
const { getAttendance, markAttendance, getStudentAttendance, getBatchAttendanceReport } = require('../controllers/attendanceController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/batch/:batchId', getAttendance);
router.post('/batch/:batchId', markAttendance);
router.get('/student/:studentId', getStudentAttendance);
router.get('/report/:batchId', getBatchAttendanceReport);

module.exports = router;
