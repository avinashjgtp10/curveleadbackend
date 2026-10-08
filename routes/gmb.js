const express = require('express');
const router = express.Router();
const { getGmbSettings, updateGmbSettings, draftReviewMessage, connectGmb, gmbOauthCallback, disconnectGmb } = require('../controllers/gmbController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

// Public — Google redirects the user's browser here directly after consent,
// with no auth header of ours attached. Must be declared before the
// authenticate/tenantContext middleware below, which only applies to routes
// registered after it.
router.get('/oauth/callback', gmbOauthCallback);

const admin = requirePermission('settings.manage');

router.use(authenticate, tenantContext);

router.get('/settings', admin, getGmbSettings);
router.put('/settings', admin, updateGmbSettings);
router.post('/draft-message', admin, draftReviewMessage);
router.get('/oauth/connect', admin, connectGmb);
router.post('/oauth/disconnect', admin, disconnectGmb);

module.exports = router;
