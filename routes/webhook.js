const express = require('express');
const router = express.Router();
const { verifyWebhook, receiveLeadFormWebhook } = require('../controllers/metaWebhookController');

router.get('/meta', verifyWebhook);
router.post('/meta', receiveLeadFormWebhook);

module.exports = router;
