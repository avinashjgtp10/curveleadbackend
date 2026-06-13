const express = require('express');
const router = express.Router();
const { getStaff, createStaff, updateStaff, deleteStaff } = require('../controllers/staffController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getStaff);
router.post('/', adminOnly, checkPlanLimit('max_users'), createStaff);
router.post('/invite', adminOnly, checkPlanLimit('max_users'), createStaff);
router.put('/:id', adminOnly, updateStaff);
router.delete('/:id', adminOnly, deleteStaff);

module.exports = router;
