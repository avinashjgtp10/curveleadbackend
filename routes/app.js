const express = require('express');
const router = express.Router();
const { getVersion } = require('../controllers/appController');

// Deliberately no authenticate/tenantContext — update checks run before login.
router.get('/version', getVersion);

module.exports = router;
