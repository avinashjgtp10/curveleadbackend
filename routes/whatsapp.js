const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const {
  getInbox, getConversation, sendMessage, setConversationAi, startChat, sendAttachment, handleWebhook,
  updateChatLabels, deleteConversations, markConversationsRead,
} = require('../controllers/whatsappController');
const { getSendableTemplates, getBroadcastTemplates, createBroadcastTemplate, aiDraftTemplate, getImagePrompt, generateHeaderImages, sendBroadcast, uploadBroadcastMedia } = require('../controllers/whatsappBroadcastController');
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
router.put('/conversation/:leadId/attributes', async(req,res)=>{
 try {
 const fields=req.body.custom_fields;
 if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).length>50||Object.entries(fields).some(([k,v])=>!k.trim()||k.length>100||typeof v!=='string'||v.length>2000))return res.status(422).json({error:'Attributes must be up to 50 name/text pairs.'});
 const result=await require('../config/db').query(`UPDATE leads SET custom_fields=$1::jsonb WHERE id=$2 AND tenant_id=$3 AND ($4::boolean OR assigned_to=$5) RETURNING custom_fields`,[JSON.stringify(fields),req.params.leadId,req.tenantId,req.user.role!=='staff',req.user.id]);
 if(!result.rows.length)return res.status(404).json({error:'Lead not found.'});
 res.json(result.rows[0]);
 }catch(e){res.status(500).json({error:'Save failed.'});}
});
router.get('/inbox', getInbox);
router.get('/conversation/:leadId', getConversation);
router.post('/send', sendMessage);
router.put('/conversation/:leadId/ai', setConversationAi);
router.post('/start-chat', startChat);
router.get('/templates/sendable', getSendableTemplates);
router.post('/send-attachment', sendAttachment);
router.post('/labels', updateChatLabels);
router.delete('/conversations', deleteConversations);
router.put('/conversations/read', markConversationsRead);
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
router.get('/hub/booking-messages', admin, hub.getBookingMessages);
router.put('/hub/booking-messages', admin, hub.updateBookingMessages);
router.get('/hub/ai-knowledge', admin, hub.getAiKnowledge);
router.put('/hub/ai-knowledge', admin, hub.updateAiKnowledge);
router.get('/hub/ai-replies', admin, hub.getAiReplies);
router.post('/hub/ai-agent/draft', admin, hub.draftAiAgent);
router.post('/hub/ai-agent/share-file', admin, uploadTemplateMedia.single('file'), hub.uploadAiShareFile);
router.delete('/hub/ai-agent/share-file/:action', admin, hub.removeAiShareFile);
router.post('/broadcast/send', requirePermission('leads.bulk_edit'), sendBroadcast);

module.exports = router;
