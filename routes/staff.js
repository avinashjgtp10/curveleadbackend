const express = require('express');
const router = express.Router();
const {
  getStaff, getStaffDetail, createStaff, updateStaff,
  checkIn, checkOut, overrideStatus, getTimeLogs,
  addIncentive, deleteIncentive, getTrainers, updateSettings, markStaffAttendance
} = require('../controllers/staffController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext, adminOnly);

router.get('/trainers', getTrainers);
router.get('/time-logs', getTimeLogs);
router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
router.put('/time-logs/:id/override', overrideStatus);
router.post('/attendance', markStaffAttendance);
router.put('/settings', updateSettings);
router.post('/incentives', addIncentive);
router.delete('/incentives/:id', deleteIncentive);

router.get('/', getStaff);
router.get('/:id', getStaffDetail);
router.post('/', createStaff);
router.put('/:id', updateStaff);

module.exports = router;
