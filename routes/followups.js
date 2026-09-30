const express = require('express');
const router = express.Router();
const { getSummary, reviewFollowup, getFollowups, updateFollowup, completeFollowup, deleteFollowup } = require('../controllers/followupController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/summary', getSummary);
router.put('/:id/review', reviewFollowup);
router.get('/', getFollowups);
router.put('/:id/complete', completeFollowup);
router.put('/:id', updateFollowup);
router.delete('/:id', deleteFollowup);

module.exports = router;
