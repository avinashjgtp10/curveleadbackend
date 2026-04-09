const express = require('express');
const router = express.Router();
const {
  getActivities, addActivity, logCall, logWhatsApp, logVisit, logNote
} = require('../controllers/activityController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

// Timeline
router.get('/:id/activities', getActivities);
router.post('/:id/activities', addActivity);

// Quick log actions
router.post('/:id/log-call', logCall);
router.post('/:id/log-whatsapp', logWhatsApp);
router.post('/:id/log-visit', logVisit);
router.post('/:id/log-note', logNote);

module.exports = router;
