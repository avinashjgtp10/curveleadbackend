const express = require('express');
const router = express.Router();
const { getFollowups, createFollowup, updateFollowup, completeFollowup, deleteFollowup } = require('../controllers/followupController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getFollowups);
router.post('/', createFollowup);
router.put('/:id/complete', completeFollowup);
router.put('/:id', updateFollowup);
router.delete('/:id', deleteFollowup);

module.exports = router;
