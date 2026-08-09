const express = require('express');
const router = express.Router();
const { getSettings, updateSettings, getStages, createStage, updateStage, deleteStage } = require('../controllers/settingsController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

router.use(authenticate, tenantContext);

router.get('/', getSettings);
router.put('/', requirePermission('settings.manage'), updateSettings);
router.get('/stages', getStages);
router.post('/stages', requirePermission('settings.manage'), createStage);
router.put('/stages/:id', requirePermission('settings.manage'), updateStage);
router.delete('/stages/:id', requirePermission('settings.manage'), deleteStage);

module.exports = router;
