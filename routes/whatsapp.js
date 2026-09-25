const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { getInbox, getConversation, sendMessage, handleWebhook, updateChatLabels } = require('../controllers/whatsappController');
const { getBroadcastTemplates, createBroadcastTemplate, aiDraftTemplate, getImagePrompt, generateHeaderImages, sendBroadcast, uploadBroadcastMedia } = require('../controllers/whatsappBroadcastController');
const hub = require('../controllers/whatsappHubController');
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
router.post('/labels', updateChatLabels);
router.get('/broadcast/templates', requirePermission('settings.manage'), getBroadcastTemplates);
router.post('/broadcast/templates', requirePermission('settings.manage'), createBroadcastTemplate);
router.post('/broadcast/templates/ai-draft', requirePermission('settings.manage'), aiDraftTemplate);
router.post('/broadcast/templates/image-prompt', requirePermission('settings.manage'), getImagePrompt);
router.post('/broadcast/templates/ai-image', requirePermission('settings.manage'), generateHeaderImages);
router.post('/broadcast/templates/media', requirePermission('settings.manage'), uploadTemplateMedia.single('file'), uploadBroadcastMedia);
const admin = requirePermission('settings.manage');
router.get('/hub/analytics', admin, hub.getAnalytics);
router.get('/hub/broadcasts', admin, hub.getBroadcastHistory);
router.get('/hub/scheduled', admin, hub.getScheduledBroadcasts);
router.delete('/hub/scheduled/:id', admin, hub.cancelScheduledBroadcast);
router.get('/hub/optins', admin, hub.getOptIns);
router.post('/hub/optins', admin, hub.updateOptIns);
router.put('/hub/optin-settings', admin, hub.updateOptInSettings);
router.get('/hub/numbers', admin, hub.getNumbers);
router.get('/hub/ctwa', admin, hub.getClickToWhatsApp);
router.get('/hub/auto-messages', admin, hub.getAutoMessages);
router.put('/hub/auto-messages', admin, hub.updateAutoMessages);
router.get('/hub/ai-knowledge', admin, hub.getAiKnowledge);
router.put('/hub/ai-knowledge', admin, hub.updateAiKnowledge);
router.get('/hub/ai-replies', admin, hub.getAiReplies);
router.post('/broadcast/send', requirePermission('leads.bulk_edit'), sendBroadcast);

module.exports = router;
