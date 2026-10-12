const router = require('express').Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');
const ctrl = require('../controllers/cohortController');

// Cohort reporting. Off by default per workspace (tenants.settings.reporting_cohort): every route answers 404 feature_off.
// Money figures need finance.view (admins have it); the health report is for administrators.
router.use(authenticate, tenantContext);
router.get('/metrics', requirePermission('finance.view'), ctrl.metrics);
router.get('/health', adminOnly, ctrl.health);

module.exports = router;
