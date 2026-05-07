const express = require('express');
const router = express.Router();
const { getNotifications, markAsRead, markAllAsRead, getUnreadCount } = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getNotifications);
router.get('/count', getUnreadCount);
router.put('/read-all', markAllAsRead);
router.put('/:id/read', markAsRead);

module.exports = router;
