const express = require('express');
const router = express.Router();
const { getDashboard } = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getDashboard);

module.exports = router;
