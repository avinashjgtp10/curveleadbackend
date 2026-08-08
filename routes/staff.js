const express = require('express');
const router = express.Router();
const { getStaff, createStaff, updateStaff, deleteStaff, inviteStaff, getInvitations, resendInvitation, revokeInvitation } = require('../controllers/staffController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getStaff);
router.post('/', adminOnly, checkPlanLimit('max_users'), createStaff);
router.post('/invite', adminOnly, checkPlanLimit('max_users'), inviteStaff);
router.get('/invitations', adminOnly, getInvitations);
router.post('/invitations/:id/resend', adminOnly, resendInvitation);
router.delete('/invitations/:id', adminOnly, revokeInvitation);
router.put('/:id', adminOnly, updateStaff);
router.delete('/:id', adminOnly, deleteStaff);

module.exports = router;
