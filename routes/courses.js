const express = require('express');
const router = express.Router();
const { getCourses, createCourse, updateCourse, deleteCourse } = require('../controllers/courseController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');

router.use(authenticate, tenantContext);

router.get('/', getCourses);
router.post('/', adminOnly, checkPlanLimit('max_courses'), createCourse);
router.put('/:id', adminOnly, updateCourse);
router.delete('/:id', adminOnly, deleteCourse);

module.exports = router;
