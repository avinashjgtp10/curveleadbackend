const express = require('express');
const router = express.Router();
const { getBatches, getBatch, createBatch, updateBatch, deleteBatch } = require('../controllers/batchController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getBatches);
router.get('/:id', getBatch);
router.post('/', adminOnly, createBatch);
router.put('/:id', adminOnly, updateBatch);
router.delete('/:id', adminOnly, deleteBatch);

module.exports = router;
