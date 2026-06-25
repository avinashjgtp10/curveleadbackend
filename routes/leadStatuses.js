const express = require('express');
const router = express.Router();
const {
  getStatuses, getStatusesByStage, createStatus, updateStatus,
  deleteStatus, reorderStatuses, getLeadHistory,
} = require('../controllers/leadStatusController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/by-stage',          getStatusesByStage);
router.get('/history/:leadId',   getLeadHistory);
router.get('/',                  getStatuses);
router.post('/',    adminOnly,   createStatus);
router.put('/reorder', adminOnly, reorderStatuses);
router.put('/:id',  adminOnly,   updateStatus);
router.delete('/:id', adminOnly, deleteStatus);

module.exports = router;
