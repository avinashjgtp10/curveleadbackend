const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate, adminOnly } = require('../middleware/auth');
const { uploadRecording, getLeadRecordings, getTeamRecordings, deleteRecording } = require('../controllers/recordingController');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    const ok = /^(audio|video)\//i.test(file.mimetype) ||
      /\.(mp3|mp4|wav|m4a|ogg|webm|mpeg|aac|flac|mov|avi|mkv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only audio/video files are allowed.'), ok);
  },
});

router.use(authenticate);

router.get('/team', adminOnly, getTeamRecordings);

router.get('/:leadId', getLeadRecordings);
router.post('/:leadId', upload.single('file'), uploadRecording);
router.delete('/:id', deleteRecording);

module.exports = router;
