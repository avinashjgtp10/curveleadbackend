const express = require('express');
const router = express.Router();
const { getCampaigns, getCampaign, getCampaignAds, createCampaign, updateCampaign, deleteCampaign, getCampaignStats } = require('../controllers/campaignController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');

router.use(authenticate, tenantContext);

router.get('/stats/summary', getCampaignStats);
router.get('/', getCampaigns);
router.get('/:id', getCampaign);
router.get('/:id/ads', getCampaignAds);
router.post('/', requirePermission('campaigns.manage'), createCampaign);
router.put('/:id', requirePermission('campaigns.manage'), updateCampaign);
router.delete('/:id', requirePermission('campaigns.manage'), deleteCampaign);

module.exports = router;
