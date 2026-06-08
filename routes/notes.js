const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const ctrl = require('../controllers/notesController');

router.use(authenticate, tenantContext);

router.get('/lead/:leadId', ctrl.getNotes);
router.post('/lead/:leadId', ctrl.createNote);
router.put('/lead/:leadId/:noteId', ctrl.updateNote);
router.delete('/lead/:leadId/:noteId', ctrl.deleteNote);

module.exports = router;
