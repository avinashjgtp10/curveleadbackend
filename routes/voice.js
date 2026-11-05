const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const c = require('../controllers/voiceCallingController');

// Call-placement endpoints are the abusable ones: tighter per-user bucket on top of the global limiter.
const callLimiter = rateLimit({
  windowMs: 60 * 1000, max: Number(process.env.VOICE_CALL_RATE_LIMIT_PER_MIN) || 30,
  keyGenerator: (req) => `voice:${req.user?.id || req.ip}`,
  message: { error: 'Too many call attempts, slow down.' },
});

router.use(authenticate, tenantContext);

router.get('/status', c.status);
router.post('/token', callLimiter, c.token);
router.post('/calls/authorize', callLimiter, c.authorize);
router.post('/calls', callLimiter, c.createCall);
router.post('/calls/:id/hangup', c.hangup);
router.post('/calls/:id/outcome', c.outcome);
router.get('/reports/agents', adminOnly, c.agentReport);
router.get('/calls', c.listCalls);
router.get('/calls/:id', c.getCall);
router.get('/rates', c.rates);
router.get('/numbers', c.numbers);
router.get('/wallet', c.wallet);
router.get('/wallet/transactions', c.walletTransactions);
router.post('/devices', c.registerDevice);
router.post('/wallet/topup', c.topupCreate);
router.post('/wallet/topup/verify', c.topupVerify);

module.exports = router;
