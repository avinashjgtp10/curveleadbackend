const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');
const { requireLedger } = require('../utils/financeFlags');
const ctrl = require('../controllers/financeController');

// Payment ledger. Off by default per workspace (tenants.settings.finance_ledger): every route answers 404 feature_off.
// Reading needs finance.view, writing needs finance.manage (admins have both; staff only if granted).
router.use(authenticate, tenantContext, requireLedger);

router.get('/leads/:id', requirePermission('finance.view'), ctrl.getFinance);
router.get('/audit', requirePermission('finance.view'), ctrl.audit);

router.post('/leads/:id/payments', requirePermission('finance.manage'), ctrl.createPayment);
router.post('/payments/:id/refund', requirePermission('finance.manage'), ctrl.refundPayment);
router.post('/payments/:id/reverse', requirePermission('finance.manage'), ctrl.reversePayment);
router.post('/payments/:id/complete', requirePermission('finance.manage'), ctrl.completePayment);
router.post('/payments/:id/cancel', requirePermission('finance.manage'), ctrl.cancelPayment);
router.post('/payments/:id/correct', requirePermission('finance.manage'), ctrl.correctPayment);
router.post('/leads/:id/booked-value/adjust', requirePermission('finance.manage'), ctrl.adjustBooking);
router.patch('/payments/:id/details', requirePermission('finance.manage'), ctrl.amendPayment);

module.exports = router;
