const { query } = require('../config/db');

// GET /api/leads/:id/activities - Get lead journey timeline
const getActivities = async (req, res) => {
  try {
    const { id } = req.params;

    // Verify lead belongs to tenant
    const leadCheck = await query(
      `SELECT l.*, c.name as course_name, u.name as assigned_to_name
       FROM leads l
       LEFT JOIN courses c ON l.course_interest_id = c.id
       LEFT JOIN users u ON l.assigned_to = u.id
       WHERE l.id = $1 AND l.tenant_id = $2`,
      [id, req.tenantId]
    );

    if (leadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    // Get all activities
    const activities = await query(
      `SELECT a.*, u.name as created_by_name
       FROM lead_activities a
       LEFT JOIN users u ON a.created_by = u.id
       WHERE a.lead_id = $1 AND a.tenant_id = $2
       ORDER BY a.created_at DESC`,
      [id, req.tenantId]
    );

    res.json({
      lead: leadCheck.rows[0],
      activities: activities.rows,
    });
  } catch (error) {
    console.error('Get activities error:', error);
    res.status(500).json({ error: 'Failed to fetch lead journey.' });
  }
};

// POST /api/leads/:id/activities - Log an activity
const addActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      activity_type, title, description, call_duration, call_outcome,
      whatsapp_message, next_action, next_action_date
    } = req.body;

    if (!activity_type || !title) {
      return res.status(400).json({ error: 'Activity type and title are required.' });
    }

    // Verify lead belongs to tenant
    const leadCheck = await query(
      'SELECT id FROM leads WHERE id = $1 AND tenant_id = $2',
      [id, req.tenantId]
    );
    if (leadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const result = await query(
      `INSERT INTO lead_activities 
       (tenant_id, lead_id, activity_type, title, description, call_duration, call_outcome, whatsapp_message, next_action, next_action_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.tenantId, id, activity_type, title, description, call_duration, call_outcome, whatsapp_message, next_action, next_action_date || null, req.user.id]
    );

    // If there's a next action date, update the lead's followup too
    if (next_action_date) {
      // Mark old followups as completed
      await query(
        `UPDATE lead_followups SET is_completed = true 
         WHERE lead_id = $1 AND tenant_id = $2 AND is_completed = false`,
        [id, req.tenantId]
      );

      // Create new followup
      await query(
        `INSERT INTO lead_followups (tenant_id, lead_id, notes, followup_type, next_followup_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.tenantId, id, next_action || title, activity_type, next_action_date, req.user.id]
      );
    }

    res.status(201).json({ activity: result.rows[0] });
  } catch (error) {
    console.error('Add activity error:', error);
    res.status(500).json({ error: 'Failed to log activity.' });
  }
};

// POST /api/leads/:id/log-call - Quick log a call
const logCall = async (req, res) => {
  try {
    const { id } = req.params;
    const { outcome, duration, notes, next_action, next_action_date } = req.body;

    const outcomeLabels = {
      connected: 'Connected',
      not_picked: 'Not Picked',
      busy: 'Busy',
      switched_off: 'Switched Off',
      wrong_number: 'Wrong Number',
    };

    const title = `Called - ${outcomeLabels[outcome] || outcome}`;

    const result = await query(
      `INSERT INTO lead_activities 
       (tenant_id, lead_id, activity_type, title, description, call_duration, call_outcome, next_action, next_action_date, created_by)
       VALUES ($1, $2, 'call', $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.tenantId, id, title, notes, duration, outcome, next_action, next_action_date || null, req.user.id]
    );

    // Auto update stage to 'contacted' if currently 'new'
    await query(
      `UPDATE leads SET stage = 'contacted' WHERE id = $1 AND tenant_id = $2 AND stage = 'new'`,
      [id, req.tenantId]
    );

    // Set next followup if provided
    if (next_action_date) {
      await query(
        `UPDATE lead_followups SET is_completed = true 
         WHERE lead_id = $1 AND tenant_id = $2 AND is_completed = false`,
        [id, req.tenantId]
      );
      await query(
        `INSERT INTO lead_followups (tenant_id, lead_id, notes, followup_type, outcome, next_followup_at, created_by)
         VALUES ($1, $2, $3, 'call', $4, $5, $6)`,
        [req.tenantId, id, next_action || title, outcome, next_action_date, req.user.id]
      );
    }

    res.status(201).json({ activity: result.rows[0] });
  } catch (error) {
    console.error('Log call error:', error);
    res.status(500).json({ error: 'Failed to log call.' });
  }
};

// POST /api/leads/:id/log-whatsapp - Quick log WhatsApp
const logWhatsApp = async (req, res) => {
  try {
    const { id } = req.params;
    const { direction, message, notes, next_action, next_action_date } = req.body;
    // direction: 'sent' or 'received'

    const title = direction === 'received' ? 'WhatsApp Received' : 'WhatsApp Sent';
    const activityType = direction === 'received' ? 'whatsapp_received' : 'whatsapp_sent';

    const result = await query(
      `INSERT INTO lead_activities 
       (tenant_id, lead_id, activity_type, title, description, whatsapp_message, next_action, next_action_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.tenantId, id, activityType, title, notes, message, next_action, next_action_date || null, req.user.id]
    );

    res.status(201).json({ activity: result.rows[0] });
  } catch (error) {
    console.error('Log WhatsApp error:', error);
    res.status(500).json({ error: 'Failed to log WhatsApp.' });
  }
};

// POST /api/leads/:id/log-visit - Quick log visit/walk-in
const logVisit = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, outcome, next_action, next_action_date } = req.body;

    const title = outcome === 'enrolled' ? 'Visited & Enrolled' : 'Visit to Academy';

    const result = await query(
      `INSERT INTO lead_activities 
       (tenant_id, lead_id, activity_type, title, description, next_action, next_action_date, created_by)
       VALUES ($1, $2, 'visit', $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.tenantId, id, title, notes, next_action, next_action_date || null, req.user.id]
    );

    // Auto update stage to 'interested' if they visited
    if (outcome !== 'enrolled') {
      await query(
        `UPDATE leads SET stage = 'interested' WHERE id = $1 AND tenant_id = $2 AND stage IN ('new', 'contacted')`,
        [id, req.tenantId]
      );
    }

    res.status(201).json({ activity: result.rows[0] });
  } catch (error) {
    console.error('Log visit error:', error);
    res.status(500).json({ error: 'Failed to log visit.' });
  }
};

// POST /api/leads/:id/log-note - Quick add a note
const logNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (!notes) {
      return res.status(400).json({ error: 'Note text is required.' });
    }

    const result = await query(
      `INSERT INTO lead_activities 
       (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1, $2, 'note', 'Note Added', $3, $4)
       RETURNING *`,
      [req.tenantId, id, notes, req.user.id]
    );

    res.status(201).json({ activity: result.rows[0] });
  } catch (error) {
    console.error('Log note error:', error);
    res.status(500).json({ error: 'Failed to add note.' });
  }
};

// Helper: Log stage change (called from leadController when stage updates)
const logStageChange = async (tenantId, leadId, oldStage, newStage, userId) => {
  try {
    await query(
      `INSERT INTO lead_activities 
       (tenant_id, lead_id, activity_type, title, old_value, new_value, created_by)
       VALUES ($1, $2, 'stage_change', $3, $4, $5, $6)`,
      [tenantId, leadId, `Stage: ${oldStage} → ${newStage}`, oldStage, newStage, userId]
    );
  } catch (error) {
    console.error('Log stage change error:', error);
  }
};

module.exports = { getActivities, addActivity, logCall, logWhatsApp, logVisit, logNote, logStageChange };
