const express = require('express');
const router = express.Router();
const { createOrder, verifyPayment, getInvoices, getCurrentSubscription, handleWebhook } = require('../controllers/billingController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

// Webhook is public (Razorpay sends it)
router.post('/webhook', handleWebhook);

// Protected routes
router.use(authenticate, tenantContext, adminOnly);
router.post('/create-order', createOrder);
router.post('/verify-payment', verifyPayment);
router.get('/invoices', getInvoices);
router.get('/current', getCurrentSubscription);

module.exports = router;
