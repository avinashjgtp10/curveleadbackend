const { query, transaction } = require('../config/db');

// GET /api/leads - with filters
const getLeads = async (req, res) => {
  try {
    const {
      stage, source, assigned_to, search, score, campaign_id,
      date_from, date_to, page = 1, limit = 20,
    } = req.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE l.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    if (stage) { where += ` AND l.stage = $${i++}`; params.push(stage); }
    if (source) { where += ` AND l.source = $${i++}`; params.push(source); }
    if (assigned_to) { where += ` AND l.assigned_to = $${i++}`; params.push(assigned_to); }
    if (score) { where += ` AND l.lead_score = $${i++}`; params.push(score); }
    if (campaign_id) { where += ` AND l.campaign_id = $${i++}`; params.push(campaign_id); }
    if (search) {
      where += ` AND (l.name ILIKE $${i} OR l.phone ILIKE $${i} OR l.email ILIKE $${i})`;
      params.push(`%${search}%`); i++;
    }
    if (date_from) { where += ` AND l.created_at >= $${i++}`; params.push(date_from); }
    if (date_to) { where += ` AND l.created_at <= $${i++}::date + INTERVAL '1 day'`; params.push(date_to); }

    const leadsQuery = `
      SELECT l.*,
             u.name as assigned_to_name,
             c.name as campaign_name,
             c.source as campaign_source,
             (SELECT COUNT(*) FROM followups WHERE lead_id = l.id) as followup_count,
             (SELECT MIN(scheduled_at) FROM followups WHERE lead_id = l.id AND completed = false AND scheduled_at > NOW()) as next_followup
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      LEFT JOIN campaigns c ON l.campaign_id = c.id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT $${i++} OFFSET $${i}
    `;
    params.push(limit, offset);

    const result = await query(leadsQuery, params);
    const countResult = await query(`SELECT COUNT(*) FROM leads l ${where}`, params.slice(0, -2));

    res.json({
      leads: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(countResult.rows[0].count / limit),
      },
    });
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ error: 'Failed to fetch leads.' });
  }
};

// GET /api/leads/:id
const getLead = async (req, res) => {
  try {
    const result = await query(
      `SELECT l.*, u.name as assigned_to_name, c.name as campaign_name
       FROM leads l
       LEFT JOIN users u ON l.assigned_to = u.id
       LEFT JOIN campaigns c ON l.campaign_id = c.id
       WHERE l.id = $1 AND l.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    const activities = await query(
      `SELECT a.*, u.name as user_name
       FROM lead_activities a
       LEFT JOIN users u ON a.created_by = u.id
       WHERE a.lead_id = $1 AND a.tenant_id = $2
       ORDER BY a.created_at DESC LIMIT 50`,
      [req.params.id, req.tenantId]
    );

    const followups = await query(
      `SELECT * FROM followups WHERE lead_id = $1 AND tenant_id = $2 ORDER BY scheduled_at DESC`,
      [req.params.id, req.tenantId]
    );

    const messages = await query(
      `SELECT * FROM whatsapp_messages WHERE lead_id = $1 AND tenant_id = $2 ORDER BY sent_at ASC LIMIT 100`,
      [req.params.id, req.tenantId]
    );

    res.json({ lead: result.rows[0], activities: activities.rows, followups: followups.rows, messages: messages.rows });
  } catch (error) {
    console.error('Get lead error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/leads
const createLead = async (req, res) => {
  try {
    const {
      name, phone, email, location, source, source_detail, campaign_id,
      stage, assigned_to, notes, deal_value, expected_close_date, tags,
    } = req.body;

    if (!name || !phone) return res.status(400).json({ error: 'Name and phone required.' });

    // Check duplicate
    const existing = await query(
      'SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2',
      [req.tenantId, phone]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Lead with this phone already exists.', existing_id: existing.rows[0].id });
    }

    const result = await query(
      `INSERT INTO leads (tenant_id, name, phone, email, location, source, source_detail, campaign_id,
                          stage, assigned_to, notes, deal_value, expected_close_date, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [req.tenantId, name, phone, email, location, source || 'manual', source_detail, campaign_id,
       stage || 'new', assigned_to, notes, deal_value || 0, expected_close_date, tags]
    );

    // Log activity
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
       VALUES ($1, $2, 'created', 'Lead created', $3)`,
      [req.tenantId, result.rows[0].id, req.user.id]
    );

    res.status(201).json({ message: 'Lead created.', lead: result.rows[0] });
  } catch (error) {
    console.error('Create lead error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// PUT /api/leads/:id
const updateLead = async (req, res) => {
  try {
    const allowedFields = [
      'name', 'phone', 'email', 'location', 'source', 'source_detail', 'campaign_id',
      'stage', 'assigned_to', 'notes', 'deal_value', 'expected_close_date', 'tags',
      'lead_score', 'score_reason', 'lost_reason',
    ];

    const updates = [];
    const params = [req.params.id, req.tenantId];
    let i = 3;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${i++}`);
        params.push(req.body[field]);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update.' });

    // Auto-set won_at / lost_at based on stage
    if (req.body.stage === 'won') updates.push(`won_at = NOW()`);
    if (req.body.stage === 'lost') updates.push(`lost_at = NOW()`);

    updates.push('updated_at = NOW()');

    const result = await query(
      `UPDATE leads SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

    // Log stage change
    if (req.body.stage) {
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
         VALUES ($1, $2, 'stage_change', $3, $4)`,
        [req.tenantId, req.params.id, `Moved to ${req.body.stage}`, req.user.id]
      );
    }

    res.json({ lead: result.rows[0] });
  } catch (error) {
    console.error('Update lead error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// DELETE /api/leads/:id
const deleteLead = async (req, res) => {
  try {
    const result = await query('DELETE FROM leads WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });
    res.json({ message: 'Lead deleted.' });
  } catch (error) {
    console.error('Delete lead error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/leads/:id/note - Add note/activity
const addNote = async (req, res) => {
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: 'Note required.' });

    const result = await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1, $2, 'note', 'Note added', $3, $4)
       RETURNING *`,
      [req.tenantId, req.params.id, note, req.user.id]
    );

    res.status(201).json({ activity: result.rows[0] });
  } catch (error) {
    console.error('Add note error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/leads/stages/all - Get pipeline stages
const getStages = async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM lead_stages WHERE tenant_id = $1 AND is_active = true ORDER BY pos',
      [req.tenantId]
    );
    res.json({ stages: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed.' });
  }
};

module.exports = { getLeads, getLead, createLead, updateLead, deleteLead, addNote, getStages };
