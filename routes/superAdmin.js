const express = require('express');
const router = express.Router();
const { getPlatformStats, getTenants, updateTenant, extendTrial, getPlans } = require('../controllers/superAdminController');
const { authenticate, superAdminOnly } = require('../middleware/auth');

router.use(authenticate, superAdminOnly);

router.get('/stats', getPlatformStats);
router.get('/tenants', getTenants);
router.put('/tenants/:id', updateTenant);
router.post('/tenants/:id/extend-trial', extendTrial);
router.get('/plans', getPlans);

module.exports = router;
