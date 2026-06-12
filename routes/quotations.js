const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/quotationController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

// Public — no auth required (lead-facing view link)
router.get('/public/:id', ctrl.getPublic);

router.use(authenticate, tenantContext);

router.get('/', ctrl.getAll);
router.get('/:id', ctrl.getOne);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.post('/:id/send', ctrl.send);
router.post('/:id/accept', ctrl.accept);
router.post('/:id/reject', ctrl.reject);
router.delete('/:id', ctrl.delete);

module.exports = router;
