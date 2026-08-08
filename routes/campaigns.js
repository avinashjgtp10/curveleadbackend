const express = require('express');
const router = express.Router();
const { getCampaigns, getCampaign, getCampaignAds, createCampaign, updateCampaign, deleteCampaign, getCampaignStats } = require('../controllers/campaignController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/stats/summary', getCampaignStats);
router.get('/', getCampaigns);
router.get('/:id', getCampaign);
router.get('/:id/ads', getCampaignAds);
router.post('/', createCampaign);
router.put('/:id', updateCampaign);
router.delete('/:id', adminOnly, deleteCampaign);

module.exports = router;
