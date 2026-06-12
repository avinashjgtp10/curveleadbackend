const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/templateController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/',        ctrl.getAll);
router.post('/',       ctrl.create);
router.put('/:id',     ctrl.update);
router.delete('/:id',  ctrl.delete);
router.post('/:id/send', ctrl.generate);

module.exports = router;
