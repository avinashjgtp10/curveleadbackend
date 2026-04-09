const express = require('express');
const router = express.Router();
const { getSalaryOverview, processSalary, getSalaryHistory } = require('../controllers/salaryController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext, adminOnly);

router.get('/', getSalaryOverview);
router.post('/process', processSalary);
router.get('/history', getSalaryHistory);

module.exports = router;
