const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { getPlaybook, regeneratePlaybook, getCoaching } = require('../controllers/playbookController');

router.use(authenticate, tenantContext);

router.get('/', getPlaybook);
router.post('/generate', adminOnly, regeneratePlaybook);
router.get('/coaching', adminOnly, getCoaching);

module.exports = router;
