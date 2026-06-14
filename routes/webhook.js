const express = require('express');
const router = express.Router();
const { verifyWebhook, receiveLeadFormWebhook } = require('../controllers/metaWebhookController');
const { receiveGoogleLead } = require('../controllers/googleWebhookController');

router.get('/meta', verifyWebhook);
router.post('/meta', receiveLeadFormWebhook);
router.post('/google', receiveGoogleLead);

module.exports = router;
