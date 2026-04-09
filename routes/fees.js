const express = require('express');
const router = express.Router();
const { getAllFees, getFeeDetails, recordPayment, updateInstallments, getMonthlyRevenue, getReminders, actionReminder, getReceiptData } = require('../controllers/feeController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/revenue/monthly', adminOnly, getMonthlyRevenue);
router.get('/reminders', getReminders);
router.post('/reminders/:installmentId/action', actionReminder);

router.get('/', getAllFees);
router.get('/:id', getFeeDetails);
router.post('/:id/pay', recordPayment);
router.put('/:id/installments', adminOnly, updateInstallments);
router.get('/:id/receipt/:paymentId', getReceiptData);

module.exports = router;
