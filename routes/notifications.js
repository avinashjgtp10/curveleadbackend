const express = require('express');
const router = express.Router();
const { getNotifications, markAsRead, markAllAsRead, markVisibleAsRead, getUnreadCount, getNotificationGroups } = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getNotifications);
router.get('/count', getUnreadCount);
router.get('/groups', getNotificationGroups);
router.put('/read-visible', async (req,res) => {
 const ids=req.body.ids;
 if(!Array.isArray(ids)||ids.length>50||ids.some(id=>!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id))) return res.status(422).json({error:'Provide up to 50 notification IDs.'});
 try { await require('../config/db').query('UPDATE notifications SET is_read=true WHERE tenant_id=$1 AND user_id=$2 AND id=ANY($3::uuid[])',[req.tenantId,req.user.id,ids]);res.json({message:'Marked visible notifications read.'}); }
 catch(e) { res.status(500).json({error:'Could not mark notifications read.'}); }
});
router.put('/read-all', markAllAsRead);
router.put('/read-visible', markVisibleAsRead);
router.put('/:id/read', markAsRead);

module.exports = router;
