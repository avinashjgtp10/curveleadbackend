const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { getInbox, getConversation, sendMessage, handleWebhook } = require('../controllers/whatsappController');
const { getBroadcastTemplates, createBroadcastTemplate, sendBroadcast, uploadBroadcastMedia } = require('../controllers/whatsappBroadcastController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

const uploadTemplateMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.mp4', '.3gp', '.pdf'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// Webhook (no auth - public for WhatsApp Business)
router.get('/webhook', handleWebhook);
router.post('/webhook', handleWebhook);

// Protected routes
router.use(authenticate, tenantContext);
router.get('/inbox', getInbox);
router.get('/conversation/:leadId', getConversation);
router.post('/send', sendMessage);
router.get('/broadcast/templates', requirePermission('settings.manage'), getBroadcastTemplates);
router.post('/broadcast/templates', requirePermission('settings.manage'), createBroadcastTemplate);
router.post('/broadcast/templates/media', requirePermission('settings.manage'), uploadTemplateMedia.single('file'), uploadBroadcastMedia);
router.post('/broadcast/send', requirePermission('leads.bulk_edit'), sendBroadcast);

module.exports = router;
