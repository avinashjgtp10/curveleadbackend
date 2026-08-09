const express = require('express');
const router = express.Router();
const {
  getStaff, createStaff, updateStaff, deleteStaff, inviteStaff, getInvitations, resendInvitation, revokeInvitation,
  getUserPermissions, updateUserPermissions,
  getMyWhatsAppNumber, updateMyWhatsAppNumber, getStaffWhatsAppNumber, updateStaffWhatsAppNumber,
} = require('../controllers/staffController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

router.use(authenticate, tenantContext);

router.get('/', getStaff);
router.post('/', requirePermission('staff.manage'), checkPlanLimit('max_users'), createStaff);
router.post('/invite', requirePermission('staff.manage'), checkPlanLimit('max_users'), inviteStaff);
router.get('/invitations', requirePermission('staff.manage'), getInvitations);
router.post('/invitations/:id/resend', requirePermission('staff.manage'), resendInvitation);
router.delete('/invitations/:id', requirePermission('staff.manage'), revokeInvitation);
router.get('/:id/permissions', adminOnly, getUserPermissions);
router.put('/:id/permissions', adminOnly, updateUserPermissions);
router.get('/me/whatsapp-number', getMyWhatsAppNumber);
router.put('/me/whatsapp-number', updateMyWhatsAppNumber);
router.get('/:id/whatsapp-number', requirePermission('staff.manage'), getStaffWhatsAppNumber);
router.put('/:id/whatsapp-number', requirePermission('staff.manage'), updateStaffWhatsAppNumber);
router.put('/:id', requirePermission('staff.manage'), updateStaff);
router.delete('/:id', requirePermission('staff.manage'), deleteStaff);

module.exports = router;
