const express = require('express');
const router = express.Router();
const { getPlans, createOrder, verifyPayment } = require('../controllers/paymentController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/plans', getPlans);
router.post('/create-order', adminOnly, createOrder);
router.post('/verify', adminOnly, verifyPayment);

module.exports = router;
