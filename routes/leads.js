const express = require('express');
const router = express.Router();
const { getLeads, getLead, createLead, updateLead, deleteLead, addNote, addFollowup, getStages, getTodayFollowups, bulkUpdate, bulkDelete, getDuplicateLeads, mergeDuplicateLeads, importLeads, getImportTemplate, getLeadStats, exportLeads, logCallClick, markContacted } = require('../controllers/leadController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext, checkPlanLimit } = require('../middleware/tenant');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only CSV and Excel files are allowed.'), ok);
  },
});

router.use(authenticate, tenantContext);

router.get('/stages/all', getStages);
router.get('/stats', getLeadStats);
router.get('/followups/today', getTodayFollowups);
router.put('/bulk', bulkUpdate);
router.delete('/bulk', adminOnly, bulkDelete);
router.get('/duplicates', adminOnly, getDuplicateLeads);
router.post('/duplicates/merge', adminOnly, mergeDuplicateLeads);
router.get('/import/template', getImportTemplate);
router.post('/import', adminOnly, upload.single('file'), importLeads);
router.get('/export', exportLeads);
router.get('/', getLeads);
router.get('/:id', getLead);
router.post('/', checkPlanLimit('max_leads'), createLead);
router.put('/:id', updateLead);
router.delete('/:id', adminOnly, deleteLead);
router.post('/:id/note', addNote);
router.post('/:id/followups', addFollowup);
router.post('/:id/call-click', logCallClick);
router.post('/:id/mark-contacted', markContacted);

module.exports = router;
