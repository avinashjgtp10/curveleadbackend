const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const ctrl = require('../controllers/quotationsController');

router.use(authenticate, tenantContext);

router.get('/', ctrl.getQuotations);
router.get('/:id', ctrl.getQuotation);
router.post('/', ctrl.createQuotation);
router.put('/:id', ctrl.updateQuotation);
router.post('/:id/send', ctrl.sendQuotation);
router.post('/:id/accept', ctrl.acceptQuotation);
router.post('/:id/reject', ctrl.rejectQuotation);
router.delete('/:id', ctrl.deleteQuotation);

module.exports = router;
