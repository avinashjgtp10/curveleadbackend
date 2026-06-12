const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const ctrl = require('../controllers/brochureController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

router.use(authenticate, tenantContext);

router.get('/', ctrl.getAll);
router.post('/', adminOnly, upload.single('file'), ctrl.upload);
router.delete('/:id', adminOnly, ctrl.delete);
router.post('/:brochureId/share/:leadId', ctrl.shareWithLead);

module.exports = router;
