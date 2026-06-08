const express = require('express');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const ctrl = require('../controllers/brochuresController');

module.exports = (upload) => {
  const router = express.Router();
  router.use(authenticate, tenantContext);

  router.get('/', ctrl.getBrochures);
  router.post('/', upload.single('file'), ctrl.uploadBrochure);
  router.delete('/:id', ctrl.deleteBrochure);
  router.post('/:id/share/:leadId', ctrl.shareBrochureWithLead);

  return router;
};
