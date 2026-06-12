const express = require('express');
const router = express.Router();
const { getStages, createStage, updateStage, deleteStage } = require('../controllers/settingsController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getStages);
router.post('/', adminOnly, createStage);
router.put('/:id', adminOnly, updateStage);
router.delete('/:id', adminOnly, deleteStage);

module.exports = router;
