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

module.exports = router;
