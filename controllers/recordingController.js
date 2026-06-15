const { query } = require('../config/db');
const { uploadToS3, getPresignedUrl, downloadFromS3 } = require('../config/s3');
const { transcribeAudio, analyzeRecording } = require('../services/groqService');

const GROQ_MAX_BYTES = 25 * 1024 * 1024; // 25 MB Groq Whisper limit

// Process transcription + analysis in background after upload response is sent
const processRecording = async (recordingId, buffer, filename, mimetype, tenantId, leadId, recordingType) => {
  try {
    await query(`UPDATE call_recordings SET analysis_status='processing' WHERE id=$1`, [recordingId]);

    if (buffer.length > GROQ_MAX_BYTES) {
      await query(`UPDATE call_recordings SET analysis_status='too_large' WHERE id=$1`, [recordingId]);
      return;
    }

    const transcription = await transcribeAudio(buffer, filename, mimetype);

    // Fetch names for context
    const [leadRes, recRes] = await Promise.all([
      query('SELECT name FROM leads WHERE id=$1', [leadId]),
      query('SELECT u.name as staff_name FROM call_recordings r JOIN users u ON r.uploaded_by=u.id WHERE r.id=$1', [recordingId]),
    ]);

    const analysis = await analyzeRecording({
      transcription,
      recordingType,
      leadName: leadRes.rows[0]?.name,
      staffName: recRes.rows[0]?.staff_name,
    });

    await query(
      `UPDATE call_recordings SET transcription=$1, analysis=$2, analysis_status='done' WHERE id=$3`,
      [transcription, JSON.stringify(analysis), recordingId]
    );

    // Log activity on the lead
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       SELECT tenant_id, lead_id, 'recording_analyzed', 'AI Call Analysis Ready',
              'Pitch score: ' || ($2::jsonb->>'overall_score') || '/10',
              uploaded_by
       FROM call_recordings WHERE id=$1`,
      [recordingId, JSON.stringify(analysis)]
    ).catch(() => {});

  } catch (e) {
    console.error('[Recording] Processing error:', e.message);
    await query(
      `UPDATE call_recordings SET analysis_status='failed', analysis=$1 WHERE id=$2`,
      [JSON.stringify({ error: e.message }), recordingId]
    ).catch(() => {});
  }
};

// POST /api/recordings/:leadId
const uploadRecording = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const { leadId } = req.params;
    const { title } = req.body;
    const isVideo = /^video\//i.test(req.file.mimetype);
    const recordingType = isVideo ? 'video' : 'audio';

    // Verify lead belongs to this tenant
    const leadCheck = await query('SELECT id FROM leads WHERE id=$1 AND tenant_id=$2', [leadId, req.tenantId]);
    if (!leadCheck.rows.length) return res.status(404).json({ error: 'Lead not found.' });

    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const key = `recordings/${req.tenantId}/${leadId}/${Date.now()}.${ext}`;
    const fileUrl = await uploadToS3(req.file.buffer, key, req.file.mimetype);

    const result = await query(
      `INSERT INTO call_recordings
         (tenant_id, lead_id, uploaded_by, recording_type, title, file_name, file_url, file_size, analysis_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
      [req.tenantId, leadId, req.user.id, recordingType,
       title || `${recordingType === 'video' ? 'Demo' : 'Call'} Recording`,
       req.file.originalname, fileUrl, req.file.size]
    );

    const recording = result.rows[0];
    res.status(201).json({ recording });

    // Kick off transcription + analysis async (don't await)
    processRecording(
      recording.id, req.file.buffer, req.file.originalname,
      req.file.mimetype, req.tenantId, leadId, recordingType
    );

  } catch (e) {
    console.error('Upload recording error:', e);
    res.status(500).json({ error: e.message || 'Upload failed.' });
  }
};

// GET /api/recordings/:leadId
const getLeadRecordings = async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, u.name as uploaded_by_name
       FROM call_recordings r
       LEFT JOIN users u ON r.uploaded_by = u.id
       WHERE r.lead_id=$1 AND r.tenant_id=$2
       ORDER BY r.created_at DESC`,
      [req.params.leadId, req.tenantId]
    );
    // Attach presigned URLs for playback
    const recordings = await Promise.all(result.rows.map(async r => ({
      ...r,
      playback_url: r.file_url ? await getPresignedUrl(r.file_url, 3600).catch(() => r.file_url) : null,
    })));
    res.json({ recordings });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/recordings/team  — admin: all recordings across all leads
const getTeamRecordings = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;
    let where = 'WHERE r.tenant_id=$1';
    const params = [req.tenantId];
    if (status) { where += ` AND r.analysis_status=$2`; params.push(status); }

    const [rows, count] = await Promise.all([
      query(
        `SELECT r.id, r.lead_id, r.recording_type, r.title, r.file_size,
                r.analysis_status, r.created_at,
                r.analysis->>'overall_score' as pitch_score,
                r.analysis->>'customer_sentiment' as sentiment,
                r.analysis->>'next_action' as next_action,
                l.name as lead_name,
                u.name as uploaded_by_name
         FROM call_recordings r
         JOIN leads l ON r.lead_id = l.id
         LEFT JOIN users u ON r.uploaded_by = u.id
         ${where} ORDER BY r.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) FROM call_recordings r ${where}`, params),
    ]);

    res.json({
      recordings: rows.rows,
      pagination: { total: parseInt(count.rows[0].count), page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/recordings/:id/retry
const retryAnalysis = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM call_recordings WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.tenantId]
    );
    const rec = result.rows[0];
    if (!rec) return res.status(404).json({ error: 'Recording not found.' });
    if (rec.analysis_status === 'processing') return res.status(409).json({ error: 'Already processing.' });
    if (!rec.file_url) return res.status(400).json({ error: 'No file to re-analyze.' });

    await query(`UPDATE call_recordings SET analysis_status='pending', analysis=NULL, transcription=NULL WHERE id=$1`, [rec.id]);
    res.json({ message: 'Retry started.' });

    // Async re-process
    (async () => {
      try {
        const buffer = await downloadFromS3(rec.file_url);
        await processRecording(rec.id, buffer, rec.file_name, rec.recording_type === 'video' ? 'video/mp4' : 'audio/mpeg', rec.tenant_id, rec.lead_id, rec.recording_type);
      } catch (e) {
        await query(`UPDATE call_recordings SET analysis_status='failed', analysis=$1 WHERE id=$2`,
          [JSON.stringify({ error: e.message }), rec.id]).catch(() => {});
      }
    })();
  } catch (e) {
    console.error('Retry error:', e);
    res.status(500).json({ error: 'Retry failed.' });
  }
};

// DELETE /api/recordings/:id
const deleteRecording = async (req, res) => {
  try {
    const { deleteFromS3 } = require('../config/s3');
    const result = await query(
      'DELETE FROM call_recordings WHERE id=$1 AND tenant_id=$2 RETURNING file_url',
      [req.params.id, req.tenantId]
    );
    if (result.rows[0]?.file_url) deleteFromS3(result.rows[0].file_url).catch(() => {});
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { uploadRecording, getLeadRecordings, getTeamRecordings, deleteRecording, retryAnalysis };
