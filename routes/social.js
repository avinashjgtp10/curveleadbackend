const router = require('express').Router();
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');
const { requirePermission } = require('../utils/permissions');
const { MAX_VIDEO_BYTES } = require('../services/social/media');
const ctrl = require('../controllers/socialController');

// Posting goes out under the business's name, so the module needs social.publish
// (admins always have it; staff only if granted).
router.use(authenticate, tenantContext, requirePermission('social.publish'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } });
const single = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(422).json({ error: 'Videos can be up to 100 MB and photos up to 8 MB.' });
  if (err) return res.status(422).json({ error: err.message });
  next();
});

router.get('/accounts', ctrl.listAccounts);
router.post('/accounts/connect', ctrl.connectMeta);
router.post('/accounts/refresh', ctrl.refreshMeta);
router.post('/accounts/gbp', ctrl.connectGbp);
router.patch('/accounts/:id', ctrl.updateAccount);

router.post('/media', single, ctrl.uploadMedia);
router.post('/captions', ctrl.captions);

router.get('/calendar', ctrl.calendar);
router.get('/posts', ctrl.listPosts);
router.post('/posts', ctrl.createPost);
router.get('/posts/:id', ctrl.getPost);
router.put('/posts/:id', ctrl.updatePost);
router.delete('/posts/:id', ctrl.deletePost);
router.post('/posts/:id/publish-now', ctrl.publishNow);
router.post('/posts/:id/retry', ctrl.retryPost);

module.exports = router;
