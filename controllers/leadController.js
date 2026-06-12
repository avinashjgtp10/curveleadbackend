const { query, transaction } = require('../config/db');

// GET /api/leads - with filters
const getLeads = async (req, res) => {
  try {
    const { stage, source, score, assigned_to, search, date_from, date_to, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE l.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    if (stage) { whereClause += ` AND l.stage = $${i++}`; params.push(stage); }
    if (source) { whereClause += ` AND l.source = $${i++}`; params.push(source); }
    if (score) { whereClause += ` AND l.lead_score = $${i++}`; params.push(score); }
    if (assigned_to) { whereClause += ` AND l.assigned_to = $${i++}`; params.push(assigned_to); }
    if (search) {
      whereClause += ` AND (l.name ILIKE $${i} OR l.phone ILIKE $${i})`;
      params.push(`%${search}%`);
      i++;
    }
    if (date_from) { whereClause += ` AND COALESCE(l.lead_date, l.created_at) >= $${i++}`; params.push(date_from); }
    if (date_to) { whereClause += ` AND COALESCE(l.lead_date, l.created_at) < $${i++}::date + INTERVAL '1 day'`; params.push(date_to); }

    const limitParam = i++;
    const offsetParam = i;
    params.push(limit, offset);

    const leadsQuery = `
      SELECT l.*,
             u.name as assigned_to_name,
             c.name as campaign_name,
             c.source as campaign_source,
             (SELECT COUNT(*) FROM followups WHERE lead_id = l.id) as followup_count,
             (SELECT MIN(scheduled_at) FROM followups WHERE lead_id = l.id AND scheduled_at > NOW()) as next_followup
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      LEFT JOIN campaigns c ON l.campaign_id = c.id
      ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const result = await query(leadsQuery, params);
    const countResult = await query(`SELECT COUNT(*) FROM leads l ${whereClause}`, params.slice(0, -2));

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

    // Get follow-ups
    const followups = await query(
      `SELECT f.*, u.name as created_by_name
       FROM lead_followups f
       LEFT JOIN users u ON f.created_by = u.id
       WHERE f.lead_id = $1
       ORDER BY f.created_at DESC`,
      [req.params.id]
    );

    // Get activity timeline
    const activities = await query(
      `SELECT a.*, u.name as created_by_name
       FROM lead_activities a
       LEFT JOIN users u ON a.created_by = u.id
       WHERE a.lead_id = $1 AND a.tenant_id = $2
       ORDER BY a.created_at DESC`,
      [req.params.id, req.tenantId]
    );

    res.json({
      lead: result.rows[0],
      followups: followups.rows,
      activities: activities.rows,
    });
  } catch (error) {
    console.error('Get lead error:', error);
    res.status(500).json({ error: 'Failed to fetch lead.' });
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
      'lead_score', 'score_reason', 'won_lost_reason',
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
    const { notes, followup_type, outcome, next_followup_at, whatsapp_log } = req.body;

    if (!notes) {
      return res.status(400).json({ error: 'Follow-up notes are required.' });
    }

    // Verify lead belongs to tenant
    const leadCheck = await query(
      'SELECT id FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (leadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    // Mark previous incomplete followups as completed
    await query(
      `UPDATE lead_followups SET is_completed = true 
       WHERE lead_id = $1 AND tenant_id = $2 AND is_completed = false`,
      [req.params.id, req.tenantId]
    );

    const result = await query(
      `INSERT INTO lead_followups (tenant_id, lead_id, notes, followup_type, outcome, next_followup_at, whatsapp_log, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.tenantId, req.params.id, notes, followup_type, outcome, next_followup_at, whatsapp_log, req.user.id]
    );

    // Create notification for next follow-up
    if (next_followup_at) {
      const lead = (await query('SELECT name, assigned_to FROM leads WHERE id = $1', [req.params.id])).rows[0];
      if (lead.assigned_to) {
        await query(
          `INSERT INTO notifications (tenant_id, user_id, title, message, type, reference_type, reference_id)
           VALUES ($1, $2, $3, $4, 'followup_due', 'lead', $5)`,
          [req.tenantId, lead.assigned_to, 'Follow-up Reminder', `Follow up with ${lead.name}`, req.params.id]
        );
      }
    }

    // Log activity
    const activityTypes = { call: 'call', whatsapp: 'whatsapp', visit: 'visit', other: 'note' };
    const activityTitles = { call: 'Phone call', whatsapp: 'WhatsApp message', visit: 'Visit', other: 'Note added' };
    const actType = activityTypes[followup_type] || 'note';
    const actTitle = activityTitles[followup_type] || 'Follow-up';
    const outcomeText = outcome ? ` — ${outcome.replace(/_/g, ' ')}` : '';

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, whatsapp_message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.tenantId, req.params.id, actType,
        `${actTitle}${outcomeText}`,
        notes,
        whatsapp_log || null,
        req.user.id
      ]
    );

    // If next follow-up is set, log that too
    if (next_followup_at) {
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
         VALUES ($1, $2, 'followup_set', 'Follow-up scheduled', $3, $4)`,
        [req.tenantId, req.params.id, `Next follow-up on ${new Date(next_followup_at).toLocaleString('en-IN')}`, req.user.id]
      );
    }

    res.status(201).json({ followup: result.rows[0] });
  } catch (error) {
    console.error('Add followup error:', error);
    res.status(500).json({ error: 'Failed to add follow-up.' });
  }
};

// GET /api/leads/stats - Lead statistics for dashboard
const getLeadStats = async (req, res) => {
  try {
    // Leads by stage
    const byStage = await query(
      `SELECT stage, COUNT(*) as count FROM leads 
       WHERE tenant_id = $1 GROUP BY stage`,
      [req.tenantId]
    );

    // Leads by source
    const bySource = await query(
      `SELECT source, COUNT(*) as count FROM leads 
       WHERE tenant_id = $1 GROUP BY source`,
      [req.tenantId]
    );

    // This month's leads
    const thisMonth = await query(
      `SELECT COUNT(*) FROM leads 
       WHERE tenant_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)`,
      [req.tenantId]
    );

    // Conversion rate (enrolled / total)
    const totalLeads = await query('SELECT COUNT(*) FROM leads WHERE tenant_id = $1', [req.tenantId]);
    const enrolledLeads = await query(
      "SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND stage = 'enrolled'",
      [req.tenantId]
    );

    const total = parseInt(totalLeads.rows[0].count);
    const enrolled = parseInt(enrolledLeads.rows[0].count);
    const conversionRate = total > 0 ? ((enrolled / total) * 100).toFixed(1) : 0;

    // Today's follow-ups
    const todayFollowups = await query(
      `SELECT COUNT(*) FROM lead_followups 
       WHERE tenant_id = $1 AND is_completed = false 
       AND DATE(next_followup_at) = CURRENT_DATE`,
      [req.tenantId]
    );

    // Overdue follow-ups
    const overdueFollowups = await query(
      `SELECT COUNT(*) FROM lead_followups 
       WHERE tenant_id = $1 AND is_completed = false 
       AND next_followup_at < CURRENT_TIMESTAMP`,
      [req.tenantId]
    );

    // Monthly trend (last 6 months)
    const monthlyTrend = await query(
      `SELECT 
        TO_CHAR(created_at, 'YYYY-MM') as month,
        COUNT(*) as count
       FROM leads WHERE tenant_id = $1 
       AND created_at >= CURRENT_DATE - INTERVAL '6 months'
       GROUP BY TO_CHAR(created_at, 'YYYY-MM')
       ORDER BY month`,
      [req.tenantId]
    );

    res.json({
      byStage: byStage.rows,
      bySource: bySource.rows,
      thisMonth: parseInt(thisMonth.rows[0].count),
      conversionRate: parseFloat(conversionRate),
      todayFollowups: parseInt(todayFollowups.rows[0].count),
      overdueFollowups: parseInt(overdueFollowups.rows[0].count),
      monthlyTrend: monthlyTrend.rows,
    });
  } catch (error) {
    console.error('Lead stats error:', error);
    res.status(500).json({ error: 'Failed to fetch lead stats.' });
  }
};

// GET /api/leads/followups/today - Follow-ups with optional filters
const getTodayFollowups = async (req, res) => {
  try {
    const { search, type, date_from, date_to } = req.query;

    let where = 'WHERE f.tenant_id = $1 AND f.is_completed = false';
    const params = [req.tenantId];
    let idx = 2;

    // If no date range provided, default to today + overdue
    if (!date_from && !date_to) {
      where += ` AND DATE(f.next_followup_at) <= CURRENT_DATE`;
    }
    if (date_from) {
      where += ` AND DATE(f.next_followup_at) >= $${idx++}`;
      params.push(date_from);
    }
    if (date_to) {
      where += ` AND DATE(f.next_followup_at) <= $${idx++}`;
      params.push(date_to);
    }
    if (type) {
      where += ` AND f.followup_type = $${idx++}`;
      params.push(type);
    }
    if (search) {
      where += ` AND (l.name ILIKE $${idx} OR l.phone ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const result = await query(
      `SELECT f.*, l.name as lead_name, l.phone as lead_phone, l.stage as lead_stage,
              u.name as assigned_to_name
       FROM lead_followups f
       JOIN leads l ON f.lead_id = l.id
       LEFT JOIN users u ON l.assigned_to = u.id
       ${where}
       ORDER BY f.next_followup_at ASC`,
      params
    );

    res.json({ followups: result.rows });
  } catch (error) {
    console.error('Today followups error:', error);
    res.status(500).json({ error: 'Failed to fetch follow-ups.' });
  }
};

// GET /api/leads/:id/journey - Full lead journey timeline
const getLeadJourney = async (req, res) => {
  try {
    // Verify lead belongs to tenant
    const leadCheck = await query(
      `SELECT l.*, c.name as course_name, u.name as assigned_to_name
       FROM leads l
       LEFT JOIN courses c ON l.course_interest_id = c.id
       LEFT JOIN users u ON l.assigned_to = u.id
       WHERE l.id = $1 AND l.tenant_id = $2`,
      [req.params.id, req.tenantId]
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
      [req.params.id, req.tenantId]
    );

    // Get follow-ups
    const followups = await query(
      `SELECT f.*, u.name as created_by_name
       FROM lead_followups f
       LEFT JOIN users u ON f.created_by = u.id
       WHERE f.lead_id = $1 AND f.tenant_id = $2
       ORDER BY f.created_at DESC`,
      [req.params.id, req.tenantId]
    );

    res.json({
      lead: leadCheck.rows[0],
      activities: activities.rows,
      followups: followups.rows,
    });
  } catch (error) {
    console.error('Lead journey error:', error);
    res.status(500).json({ error: 'Failed to fetch lead journey.' });
  }
};

// POST /api/leads/:id/activities - Manually log an activity
const addActivity = async (req, res) => {
  try {
    const { activity_type, title, description } = req.body;

    if (!activity_type || !title) {
      return res.status(400).json({ error: 'Activity type and title are required.' });
    }

    // Verify lead
    const leadCheck = await query(
      'SELECT id FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (leadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

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
