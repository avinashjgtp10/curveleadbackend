const express = require('express');
const router = express.Router();
const { submitTicket, getMyTickets } = require('../controllers/supportController');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.post('/tickets', submitTicket); // public contact form, or authenticated in-app request
router.get('/tickets', authenticate, tenantContext, getMyTickets);

module.exports = router;
