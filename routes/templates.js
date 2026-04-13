const express = require('express');
const router = express.Router();
const { getTemplates, createTemplate, updateTemplate, deleteTemplate, generateMessage } = require('../controllers/templateController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getTemplates);
router.post('/', adminOnly, createTemplate);
router.put('/:id', adminOnly, updateTemplate);
router.delete('/:id', adminOnly, deleteTemplate);
router.post('/:id/send', generateMessage);

module.exports = router;
