const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');
const ctrl = require('../controllers/adsController');

// Ad spend, budgets and account connections are workspace-level, so the whole
// module needs ads.manage (admins always have it; staff only if granted).
router.use(authenticate, tenantContext, requirePermission('ads.manage'));

router.get('/accounts', ctrl.listAccounts);
router.post('/accounts/connect', ctrl.connectAccounts);
router.post('/accounts/:id/primary', ctrl.setPrimary);
router.post('/accounts/:id/sync', ctrl.syncNow);

router.get('/campaigns', ctrl.listCampaigns);
router.get('/campaigns/:id/adsets', ctrl.listAdsets);
router.get('/adsets/:id/ads', ctrl.listAds);
router.get('/insights/daily', ctrl.dailyInsights);
router.get('/dashboard', ctrl.dashboard);

// Lead Ads (Phase 2)
router.get('/forms', ctrl.listLeadForms);
router.post('/forms/:id/backfill', ctrl.backfillLeadForm);
router.put('/lead-settings', ctrl.updateLeadSettings);

// Controls + audit (Phase 3)
router.post('/campaigns/:id/pause', ctrl.pauseCampaign);
router.post('/campaigns/:id/resume', ctrl.resumeCampaign);
router.patch('/campaigns/:id/budget', ctrl.updateCampaignBudget);
router.post('/adsets/:id/pause', ctrl.pauseAdset);
router.post('/adsets/:id/resume', ctrl.resumeAdset);
router.patch('/adsets/:id/budget', ctrl.updateAdsetBudget);
router.get('/audit', ctrl.listAudit);
router.get('/settings', ctrl.getAdsSettings);
router.put('/settings', ctrl.updateAdsSettings);

// Conversions API feedback (Phase 4)
router.get('/capi/events', ctrl.listCapiEvents);

// AI campaign creation (Phase 5) — everything is created PAUSED; activation is separate.
const imageUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
router.get('/ai/drafts', ctrl.aiListDrafts);
router.post('/ai/drafts', ctrl.aiCreateDraft);
router.get('/ai/drafts/:id', ctrl.aiGetDraft);
router.put('/ai/drafts/:id', ctrl.aiUpdateDraft);
router.post('/ai/drafts/:id/image', imageUpload.single('file'), ctrl.aiUploadImage);
router.post('/ai/drafts/:id/create', ctrl.aiCreateOnMeta);
router.post('/ai/drafts/:id/activate', ctrl.aiActivate);

module.exports = router;
