const express = require('express');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const ctrl = require('../controllers/attachmentsController');

module.exports = (upload) => {
  const router = express.Router();
  router.use(authenticate, tenantContext);

  router.get('/lead/:leadId', ctrl.getAttachments);
  router.post('/lead/:leadId', upload.single('file'), ctrl.uploadAttachment);
  router.delete('/lead/:leadId/:attachmentId', ctrl.deleteAttachment);
  router.post('/lead/:leadId/:attachmentId/share-whatsapp', ctrl.shareAttachmentOnWhatsApp);

  return router;
};
