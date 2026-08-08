const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/teamController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', ctrl.getTeams);
router.post('/', adminOnly, ctrl.createTeam);
router.put('/:id', adminOnly, ctrl.updateTeam);
router.delete('/:id', adminOnly, ctrl.deleteTeam);

module.exports = router;
