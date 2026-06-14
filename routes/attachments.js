const express = require('express');
const router = express.Router();
const multer = require('multer');
const ctrl = require('../controllers/attachmentController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(authenticate, tenantContext);

router.get('/lead/:leadId', ctrl.getByLead);
router.post('/lead/:leadId', upload.single('file'), ctrl.upload);
router.delete('/lead/:leadId/:attachmentId', ctrl.delete);
router.post('/lead/:leadId/:attachmentId/share-whatsapp', ctrl.shareWhatsApp);

module.exports = router;
