const express = require('express');
const router = express.Router();
const { authenticate, superAdminOnly } = require('../middleware/auth');
const c = require('../controllers/voiceAdminController');

// Platform-admin only. No tenantContext: a super admin may not belong to a workspace.
router.use(authenticate, superAdminOnly);
router.get('/routes', c.policies);
router.put('/routes', c.setRoute);
router.get('/tenants/:tenantId', c.overview);
router.put('/tenants/:tenantId/account', c.upsertAccount);
router.post('/tenants/:tenantId/numbers', c.addNumber);
router.put('/numbers/:id', c.updateNumber);
router.post('/rates', c.addRate);
module.exports = router;
