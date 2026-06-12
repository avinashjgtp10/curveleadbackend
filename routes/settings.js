const express = require('express');
const router = express.Router();
const { getSettings, updateSettings, getStages, createStage, updateStage, deleteStage } = require('../controllers/settingsController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getSettings);
router.put('/', adminOnly, updateSettings);
router.get('/stages', getStages);
router.post('/stages', adminOnly, createStage);
router.put('/stages/:id', adminOnly, updateStage);
router.delete('/stages/:id', adminOnly, deleteStage);

module.exports = router;
