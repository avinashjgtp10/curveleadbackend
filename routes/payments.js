const express = require('express');
const router = express.Router();
const { getPlans, createSubscription, verifySubscription, handleWebhook } = require('../controllers/paymentController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

// Public - called by Razorpay servers, verified via webhook signature (not JWT)
router.post('/webhook', handleWebhook);

router.use(authenticate, tenantContext);

router.get('/plans', getPlans);
router.post('/create-subscription', adminOnly, createSubscription);
router.post('/verify-subscription', adminOnly, verifySubscription);

module.exports = router;
