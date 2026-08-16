const express = require('express');
const router = express.Router();
const {
  getConversionReport, getReportBySource, getReportByStaff, getReportByCampaign, getTimeline, getDashboardSummary,
  getFunnelReport, getTimeInStageReport, getFollowupTrend,
} = require('../controllers/reportsController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/summary', getDashboardSummary);
router.get('/conversion', getConversionReport);
router.get('/by-source', getReportBySource);
router.get('/by-staff', getReportByStaff);
router.get('/by-campaign', getReportByCampaign);
router.get('/timeline', getTimeline);
router.get('/funnel', getFunnelReport);
router.get('/time-in-stage', getTimeInStageReport);
router.get('/followup-trend', getFollowupTrend);

module.exports = router;
