const express = require('express');
const router = express.Router();
const { getStages, createStage, updateStage, deleteStage, reorderStages } = require('../controllers/leadStageController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getStages);
router.post('/', adminOnly, createStage);
router.put('/reorder', adminOnly, reorderStages);
router.put('/:id', adminOnly, updateStage);
router.delete('/:id', adminOnly, deleteStage);

module.exports = router;
