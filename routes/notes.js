const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/noteController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/lead/:leadId', ctrl.getByLead);
router.post('/lead/:leadId', ctrl.create);
router.put('/lead/:leadId/:noteId', ctrl.update);
router.delete('/lead/:leadId/:noteId', ctrl.delete);

module.exports = router;
