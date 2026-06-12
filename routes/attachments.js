const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ctrl = require('../controllers/attachmentController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

const uploadDir = path.join(__dirname, '../uploads/attachments');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.use(authenticate, tenantContext);

router.get('/lead/:leadId', ctrl.getByLead);
router.post('/lead/:leadId', upload.single('file'), ctrl.upload);
router.delete('/lead/:leadId/:attachmentId', ctrl.delete);
router.post('/lead/:leadId/:attachmentId/share-whatsapp', ctrl.shareWhatsApp);

module.exports = router;
