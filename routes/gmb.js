const express = require('express');
const router = express.Router();
const { getGmbSettings, updateGmbSettings, draftReviewMessage } = require('../controllers/gmbController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

const admin = requirePermission('settings.manage');

router.use(authenticate, tenantContext);

router.get('/settings', admin, getGmbSettings);
router.put('/settings', admin, updateGmbSettings);
router.post('/draft-message', admin, draftReviewMessage);

module.exports = router;
