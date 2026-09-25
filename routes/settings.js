const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { getSettings, updateSettings, getStages, createStage, updateStage, deleteStage, uploadLogo } = require('../controllers/settingsController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

const uploadLogoFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

router.use(authenticate, tenantContext);

router.get('/', getSettings);
router.put('/', requirePermission('settings.manage'), updateSettings);
router.post('/logo', requirePermission('settings.manage'), uploadLogoFile.single('file'), uploadLogo);
router.get('/stages', getStages);
router.post('/stages', requirePermission('settings.manage'), createStage);
router.put('/stages/:id', requirePermission('settings.manage'), updateStage);
router.delete('/stages/:id', requirePermission('settings.manage'), deleteStage);

module.exports = router;
