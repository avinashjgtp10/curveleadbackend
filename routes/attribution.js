const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');
const ctrl = require('../controllers/attributionController');

// Which campaign originally brought a lead. Viewing and correcting need ads.manage (admins always have it).
router.use(authenticate, tenantContext, requirePermission('ads.manage'));
router.get('/leads/:id', ctrl.get);
router.post('/leads/:id/correct', ctrl.correct);

module.exports = router;
