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
} = require('../controllers/superAdminController');
const { authenticate, superAdminOnly } = require('../middleware/auth');

router.use(authenticate, superAdminOnly);

router.get('/stats', getPlatformStats);

router.get('/tenants', getTenants);
router.put('/tenants/:id', updateTenant);
router.post('/tenants/:id/extend-trial', extendTrial);

router.get('/plans', getPlans);
router.post('/plans', createPlan);
router.put('/plans/:id', updatePlan);

router.get('/users', getUsers);
router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);

router.get('/leads', getCrossTenantLeads);

router.get('/billing/summary', getBillingSummary);
router.get('/billing/workspace-revenue', getWorkspaceRevenue);
router.get('/billing/payments', getPaymentHistory);

router.get('/activity-logs', getActivityLogs);

router.get('/trends/workspace-growth', getWorkspaceGrowthTrend);
router.get('/trends/leads', getLeadsTrendData);
router.get('/trends/revenue', getRevenueTrendData);

router.get('/automations', getAutomations);

module.exports = router;
