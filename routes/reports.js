const express = require('express');
const router = express.Router();
const { getPnL, getSummary } = require('../controllers/reportsController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext, adminOnly);

router.get('/pnl', getPnL);
router.get('/summary', getSummary);

module.exports = router;
