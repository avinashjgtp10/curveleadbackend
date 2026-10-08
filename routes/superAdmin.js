const express = require('express');
const router = express.Router();
const {
  getPlatformStats, getTenants, updateTenant, extendTrial,
  getPlans, createPlan, updatePlan,
  getUsers, updateUser, deleteUser,
  getCrossTenantLeads,
  getBillingSummary, getWorkspaceRevenue, getPaymentHistory,
  getActivityLogs,
  getWorkspaceGrowthTrend, getLeadsTrendData, getRevenueTrendData,
  getAutomations,
  getCrossTenantCampaigns,
  getCrossTenantBookings,
  getCrossTenantWhatsAppConversations, getCrossTenantWhatsAppMessages, sendCrossTenantWhatsAppMessage,
  getPlatformSettings, updatePlatformSettings,
  getSupportTickets, updateSupportTicket,
} = require('../controllers/superAdminController');
const { getAiOverview } = require('../controllers/superAdminAiController');
const {
  createTenant, deleteTenant, setCampaignStatus, getCampaignSummary, createCampaign,
  getCrossTenantTemplates, updateTemplate, deleteTemplate,
} = require('../controllers/superAdminManageController');
const { getDeletionHistory, getCleanupHistory } = require('../controllers/superAdminHistoryController');
const { getLeads, getLeadsSummary, getLeadActivity } = require('../controllers/superAdminLeadsController');
const {
  listIntegrations, createIntegration, updateIntegration, testIntegration, deleteIntegration,
} = require('../controllers/superAdminAiIntegrationsController');
const { getIntegrationsOverview } = require('../controllers/superAdminIntegrationsController');
const { authenticate, superAdminOnly } = require('../middleware/auth');

router.use(authenticate, superAdminOnly);

router.get('/stats', getPlatformStats);

router.get('/tenants', getTenants);
router.post('/tenants', createTenant);
router.put('/tenants/:id', updateTenant);
router.delete('/tenants/:id', deleteTenant);
router.post('/tenants/:id/extend-trial', extendTrial);

router.get('/plans', getPlans);
router.post('/plans', createPlan);
router.put('/plans/:id', updatePlan);

router.get('/users', getUsers);
router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);

router.get('/leads/summary', getLeadsSummary);
router.get('/leads/:id/activity', getLeadActivity);
router.get('/leads', getLeads);

router.get('/billing/summary', getBillingSummary);
router.get('/billing/workspace-revenue', getWorkspaceRevenue);
router.get('/billing/payments', getPaymentHistory);

router.get('/activity-logs', getActivityLogs);

router.get('/trends/workspace-growth', getWorkspaceGrowthTrend);
router.get('/trends/leads', getLeadsTrendData);
router.get('/trends/revenue', getRevenueTrendData);

router.get('/automations', getAutomations);

router.get('/campaigns/summary', getCampaignSummary);
router.get('/campaigns', getCrossTenantCampaigns);
router.post('/campaigns', createCampaign);
router.put('/campaigns/:id/status', setCampaignStatus);

router.get('/templates', getCrossTenantTemplates);
router.put('/templates/:id', updateTemplate);
router.delete('/templates/:id', deleteTemplate);

router.get('/bookings', getCrossTenantBookings);

router.get('/settings', getPlatformSettings);
router.put('/settings', updatePlatformSettings);

router.get('/support/tickets', getSupportTickets);
router.put('/support/tickets/:id', updateSupportTicket);

router.get('/history/deletions', getDeletionHistory);
router.get('/history/cleanups', getCleanupHistory);

router.get('/ai/overview', getAiOverview);
router.get('/ai/integrations', listIntegrations);
router.post('/ai/integrations', createIntegration);
router.put('/ai/integrations/:id', updateIntegration);
router.post('/ai/integrations/:id/test', testIntegration);
router.delete('/ai/integrations/:id', deleteIntegration);
router.get('/integrations/overview', getIntegrationsOverview);

router.get('/whatsapp/conversations', getCrossTenantWhatsAppConversations);
router.get('/whatsapp/conversations/:id/messages', getCrossTenantWhatsAppMessages);
router.post('/whatsapp/conversations/:id/send', sendCrossTenantWhatsAppMessage);

module.exports = router;
