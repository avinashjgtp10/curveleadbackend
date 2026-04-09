const express = require('express');
const router = express.Router();
const { getSettings, updateSettings } = require('../controllers/settingsController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext, adminOnly);

router.get('/', getSettings);
router.put('/', updateSettings);

module.exports = router;
