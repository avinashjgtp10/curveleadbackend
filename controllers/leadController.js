const { query, transaction } = require('../config/db');

// GET /api/leads - with filters
const getLeads = async (req, res) => {
  try {
    const { stage, source, score, assigned_to, search, date_from, date_to, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE l.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    // Staff can only see their own assigned leads
    if (req.user.role === 'staff') {
      whereClause += ` AND l.assigned_to = $${i++}`;
      params.push(req.user.id);
    }

    if (stage) { whereClause += ` AND LOWER(l.stage) = LOWER($${i++})`; params.push(stage); }
    if (source) { whereClause += ` AND l.source = $${i++}`; params.push(source); }
    if (score) { whereClause += ` AND l.lead_score = $${i++}`; params.push(score); }
    if (req.user.role !== 'staff') {
      if (assigned_to === 'unassigned') { whereClause += ` AND l.assigned_to IS NULL`; }
      else if (assigned_to) { whereClause += ` AND l.assigned_to = $${i++}`; params.push(assigned_to); }
    }
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
    const isStaff = req.user.role === 'staff';
    const leadParams = isStaff
      ? [req.params.id, req.tenantId, req.user.id]
      : [req.params.id, req.tenantId];
    const [result, followups, activities] = await Promise.all([
      query(
        `SELECT l.*, u.name as assigned_to_name, c.name as campaign_name
         FROM leads l
         LEFT JOIN users u ON l.assigned_to = u.id
         LEFT JOIN campaigns c ON l.campaign_id = c.id
         WHERE l.id = $1 AND l.tenant_id = $2${isStaff ? ' AND l.assigned_to = $3' : ''}`,
        leadParams
      ),
      query(
        `SELECT f.*, u.name as created_by_name
         FROM lead_followups f
         LEFT JOIN users u ON f.created_by = u.id
         WHERE f.lead_id = $1
         ORDER BY f.created_at DESC LIMIT 1`,
        [req.params.id]
      ),
      query(
        `SELECT a.*, u.name as created_by_name
         FROM lead_activities a
         LEFT JOIN users u ON a.created_by = u.id
         WHERE a.lead_id = $1 AND a.tenant_id = $2
         ORDER BY a.created_at DESC`,
        [req.params.id, req.tenantId]
      ),
    ]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });

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
      stage, notes, deal_value, expected_close_date, tags,
    } = req.body;

    // Staff leads are always assigned to themselves
    const assigned_to = req.user.role === 'staff' ? req.user.id : (req.body.assigned_to || null);

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

    // Auto-set won_at / lost_at based on stage's is_won / is_lost flag
    if (req.body.stage) {
      const stageInfo = await query(
        'SELECT is_won, is_lost FROM lead_stages WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
        [req.tenantId, req.body.stage]
      );
      if (stageInfo.rows[0]?.is_won) updates.push('won_at = NOW()');
      if (stageInfo.rows[0]?.is_lost) updates.push('lost_at = NOW()');
    }

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
        [req.tenantId, req.params.id, `Stage changed to ${req.body.stage}`, req.user.id]
      );
    }

    // Log source change
    if (req.body.source) {
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
         VALUES ($1, $2, 'source_change', $3, $4)`,
        [req.tenantId, req.params.id, `Source changed to ${req.body.source.replace(/_/g, ' ')}`, req.user.id]
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
const addFollowup = async (req, res) => {
  try {
    const { notes, followup_type, outcome, next_followup_at, whatsapp_log, meeting_url } = req.body;

    if (!next_followup_at) {
      return res.status(400).json({ error: 'Follow-up date and time are required.' });
    }

    const leadCheck = await query(
      'SELECT id, name, email, assigned_to FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (leadCheck.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });
    const lead = leadCheck.rows[0];

    const tenantRes = await query('SELECT name FROM tenants WHERE id = $1', [req.tenantId]);
    const tenantName = tenantRes.rows[0]?.name || 'CurveLead';

    await query(
      `UPDATE lead_followups SET is_completed = true WHERE lead_id = $1 AND tenant_id = $2 AND is_completed = false`,
      [req.params.id, req.tenantId]
    );

    let result;
    try {
      result = await query(
        `INSERT INTO lead_followups (tenant_id, lead_id, notes, followup_type, next_followup_at, meeting_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.tenantId, req.params.id, notes || null, followup_type || 'call', next_followup_at, meeting_url || null, req.user.id]
      );
    } catch (colErr) {
      // Fallback: meeting_url column may not exist yet (migration pending)
      result = await query(
        `INSERT INTO lead_followups (tenant_id, lead_id, notes, followup_type, next_followup_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.tenantId, req.params.id, notes || null, followup_type || 'call', next_followup_at, req.user.id]
      );
    }

    if (lead.assigned_to) {
      await query(
        `INSERT INTO notifications (tenant_id, user_id, title, message, type, reference_type, reference_id)
         VALUES ($1, $2, $3, $4, 'followup_due', 'lead', $5)`,
        [req.tenantId, lead.assigned_to, 'Follow-up Reminder', `Follow up with ${lead.name}`, req.params.id]
      ).catch(() => {});
    }

    const isDemo = (followup_type || '').toLowerCase() === 'demo';
    const demoTime = new Date(next_followup_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.tenantId, req.params.id,
       isDemo ? 'demo_scheduled' : 'followup_scheduled',
       isDemo ? 'Demo Scheduled' : 'Follow-up Scheduled',
       isDemo && meeting_url
         ? `Scheduled for ${demoTime} · Link: ${meeting_url}`
         : `Scheduled for ${demoTime}`,
       req.user.id]
    );

    // Send demo invite email to lead if email exists
    if (isDemo && meeting_url && lead.email) {
      const { sendEmail } = require('../utils/email');
      sendEmail({
        to: lead.email,
        subject: `Your Demo is Scheduled — ${tenantName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #f9fafb; border-radius: 12px;">
            <h2 style="color: #1e1b4b; margin-bottom: 4px;">Your Demo is Confirmed! 🎥</h2>
            <p style="color: #6b7280; font-size: 14px;">Hi ${lead.name},</p>
            <p style="color: #374151; font-size: 14px;">We've scheduled a demo session for you.</p>
            <div style="background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; margin: 20px 0;">
              <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">📅 Date & Time</p>
              <p style="margin: 0 0 20px; font-size: 16px; font-weight: 600; color: #1f2937;">${demoTime}</p>
              <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em;">🔗 Meeting Link</p>
              <a href="${meeting_url}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">Join Demo</a>
              <p style="margin: 12px 0 0; font-size: 12px; color: #9ca3af;">${meeting_url}</p>
            </div>
            ${notes ? `<p style="color: #374151; font-size: 14px;"><strong>Note:</strong> ${notes}</p>` : ''}
            <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">Looking forward to speaking with you!<br/><strong>${tenantName}</strong></p>
          </div>
        `,
      }).catch(() => {});
    }

    res.status(201).json({ followup: result.rows[0], emailSent: !!(isDemo && meeting_url && lead.email) });
  } catch (error) {
    console.error('Add followup error:', error);
    res.status(500).json({ error: 'Failed to schedule follow-up.' });
  }
};

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
         VALUES ($1, $2, 'followup_scheduled', 'Follow-up Scheduled', $3, $4)`,
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
    const isStaff = req.user.role === 'staff';
    const baseParams = isStaff ? [req.tenantId, req.user.id] : [req.tenantId];
    const staffClause = isStaff ? ' AND assigned_to = $2' : '';
    const staffFollowupClause = isStaff
      ? ` AND lead_id IN (SELECT id FROM leads WHERE tenant_id = $1 AND assigned_to = $2)`
      : '';

    // Leads by stage
    const byStage = await query(
      `SELECT stage, COUNT(*) as count FROM leads
       WHERE tenant_id = $1${staffClause} GROUP BY stage`,
      baseParams
    );

    // Leads by source
    const bySource = await query(
      `SELECT source, COUNT(*) as count FROM leads
       WHERE tenant_id = $1${staffClause} GROUP BY source`,
      baseParams
    );

    // This month's leads
    const thisMonth = await query(
      `SELECT COUNT(*) FROM leads
       WHERE tenant_id = $1${staffClause} AND created_at >= date_trunc('month', CURRENT_DATE)`,
      baseParams
    );

    // Conversion rate (enrolled / total)
    const totalLeads = await query(`SELECT COUNT(*) FROM leads WHERE tenant_id = $1${staffClause}`, baseParams);
    const enrolledLeads = await query(
      `SELECT COUNT(*) FROM leads WHERE tenant_id = $1${staffClause} AND stage = 'enrolled'`,
      baseParams
    );

    const total = parseInt(totalLeads.rows[0].count);
    const enrolled = parseInt(enrolledLeads.rows[0].count);
    const conversionRate = total > 0 ? ((enrolled / total) * 100).toFixed(1) : 0;

    // Today's follow-ups
    const todayFollowups = await query(
      `SELECT COUNT(*) FROM lead_followups
       WHERE tenant_id = $1 AND is_completed = false
       AND DATE(next_followup_at) = CURRENT_DATE${staffFollowupClause}`,
      baseParams
    );

    // Overdue follow-ups
    const overdueFollowups = await query(
      `SELECT COUNT(*) FROM lead_followups
       WHERE tenant_id = $1 AND is_completed = false
       AND next_followup_at < CURRENT_TIMESTAMP${staffFollowupClause}`,
      baseParams
    );

    // Monthly trend (last 6 months)
    const monthlyTrend = await query(
      `SELECT
        TO_CHAR(created_at, 'YYYY-MM') as month,
        COUNT(*) as count
       FROM leads WHERE tenant_id = $1${staffClause}
       AND created_at >= CURRENT_DATE - INTERVAL '6 months'
       GROUP BY TO_CHAR(created_at, 'YYYY-MM')
       ORDER BY month`,
      baseParams
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

    // Staff see only follow-ups for their assigned leads
    if (req.user.role === 'staff') {
      where += ` AND l.assigned_to = $${idx++}`;
      params.push(req.user.id);
    }

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

// PUT /api/leads/bulk - Bulk update stage or assigned_to
const bulkUpdate = async (req, res) => {
  try {
    const { ids, stage, assigned_to } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'No lead IDs provided.' });

    const sets = [];
    const params = [req.tenantId];
    let i = 2;

    if (stage !== undefined) { sets.push(`stage = $${i++}`); params.push(stage); }
    if (assigned_to !== undefined) { sets.push(`assigned_to = $${i++}`); params.push(assigned_to || null); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    sets.push('updated_at = NOW()');
    params.push(ids);

    const result = await query(
      `UPDATE leads SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = ANY($${i}::uuid[]) RETURNING id`,
      params
    );

    if (stage) {
      await Promise.all(ids.map(id =>
        query(
          `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
           VALUES ($1,$2,'stage_change',$3,$4)`,
          [req.tenantId, id, `Stage changed to ${stage}`, req.user.id]
        ).catch(() => {})
      ));
    }

    res.json({ updated: result.rowCount });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// DELETE /api/leads/bulk - Bulk delete
const bulkDelete = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'No lead IDs provided.' });

    const result = await query(
      'DELETE FROM leads WHERE tenant_id = $1 AND id = ANY($2::uuid[]) RETURNING id',
      [req.tenantId, ids]
    );

    res.json({ deleted: result.rowCount });
  } catch (error) {
    console.error('Bulk delete error:', error);
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

// GET /api/leads/import/template — download a prefilled sample Excel
const getImportTemplate = async (req, res) => {
  try {
    const XLSX = require('xlsx');

    const stagesResult = await query(
      'SELECT name FROM lead_stages WHERE tenant_id = $1 AND is_active = true ORDER BY pos ASC',
      [req.tenantId]
    );
    const stageNames = stagesResult.rows.map(s => s.name);
    const s1 = stageNames[0] || 'New';
    const s2 = stageNames[1] || 'Contacted';

    const rows = [
      // Header
      ['Name *', 'Phone *', 'Email', 'Source', 'Stage', 'Notes', 'Deal Value (INR)', 'City'],
      // 5 example leads
      ['Rahul Sharma',  '9876543210', 'rahul@example.com',  'Facebook',   s1, 'Interested in premium plan', 50000,  'Mumbai'],
      ['Priya Patel',   '8765432109', 'priya@example.com',  'Google Ads', s2, 'Asked for demo',            75000,  'Pune'],
      ['Amit Kumar',    '7654321098', 'amit@example.com',   'Referral',   s1, 'Referred by existing client',100000,'Delhi'],
      ['Sneha Joshi',   '6543210987', '',                   'WhatsApp',   s2, 'Very interested, call back', 30000, 'Bangalore'],
      ['Vikram Singh',  '9988776655', 'vikram@example.com', 'Website',    s1, 'Inquired about pricing',    '',     'Chennai'],
      // blank separator
      [],
      // Allowed values reference
      [`Allowed Stages: ${stageNames.join(' | ')}`],
      ['Allowed Sources: Facebook | Google Ads | WhatsApp | Instagram | Referral | Website | Walk-in | Manual'],
      ['* = Required column. Delete these rows and the example rows before uploading your real data.'],
    ];

    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Column widths
    ws['!cols'] = [22, 14, 28, 14, 16, 32, 18, 14].map(w => ({ wch: w }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="curvelead_import_template.xlsx"');
    res.send(buf);
  } catch (error) {
    console.error('Template error:', error);
    res.status(500).json({ error: 'Failed to generate template.' });
  }
};

// POST /api/leads/import  — bulk import from CSV or Excel
const importLeads = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const XLSX = require('xlsx');
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json({ error: 'File is empty.' });
    if (rows.length > 2000) return res.status(400).json({ error: 'Max 2000 rows per import.' });

    // Normalise header key → field name
    const norm = (k) => String(k).toLowerCase().trim().replace(/[\s\-\/]+/g, '_').replace(/[^a-z0-9_]/g, '');
    const FIELD_MAP = {
      name:       ['name','full_name','customer_name','lead_name','contact_name','client_name'],
      phone:      ['phone','mobile','contact','phone_number','mobile_number','cell','telephone','tel'],
      email:      ['email','email_address','e_mail','mail'],
      source:     ['source','lead_source','channel','medium'],
      stage:      ['stage','status','lead_stage','pipeline_stage'],
      notes:      ['notes','note','comment','comments','remarks','description','details'],
      deal_value: ['deal_value','value','amount','deal_amount','price','budget','revenue'],
      city:       ['city','location','area','region'],
    };

    const sampleKeys = Object.keys(rows[0]).map(norm);
    const keyMap = {}; // normalized_header → field
    for (const [field, aliases] of Object.entries(FIELD_MAP)) {
      const match = Object.keys(rows[0]).find(k => aliases.includes(norm(k)));
      if (match) keyMap[match] = field;
    }

    // Fetch valid stages for this tenant
    const stagesResult = await query(
      'SELECT LOWER(name) as name FROM lead_stages WHERE tenant_id = $1 AND is_active = true',
      [req.tenantId]
    );
    const validStages = new Set(stagesResult.rows.map(s => s.name));

    let inserted = 0, skipped = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const lead = {};
      for (const [rawKey, field] of Object.entries(keyMap)) {
        lead[field] = String(row[rawKey] ?? '').trim();
      }

      // Require at least name
      if (!lead.name) { skipped++; continue; }

      // Normalise phone — strip non-digits, allow leading +
      if (lead.phone) lead.phone = lead.phone.replace(/[^\d+]/g, '').slice(0, 15);

      // Validate/default stage
      const stageInput = (lead.stage || '').toLowerCase().trim();
      lead.stage = validStages.has(stageInput) ? stageInput : (validStages.has('new') ? 'new' : [...validStages][0] || 'new');

      // Parse deal value
      const dv = parseFloat(String(lead.deal_value).replace(/[^0-9.]/g, ''));
      lead.deal_value = isNaN(dv) ? null : dv;

      try {
        await query(
          `INSERT INTO leads (tenant_id, name, phone, email, source, stage, notes, deal_value, city, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT DO NOTHING`,
          [
            req.tenantId,
            lead.name,
            lead.phone || null,
            lead.email || null,
            lead.source || 'import',
            lead.stage,
            lead.notes || null,
            lead.deal_value,
            lead.city || null,
            req.user.id,
          ]
        );
        inserted++;
      } catch (e) {
        errors.push({ row: i + 2, name: lead.name, error: e.message });
        skipped++;
      }
    }

    res.json({
      message: `Import complete: ${inserted} leads added, ${skipped} skipped.`,
      inserted,
      skipped,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    console.error('Import leads error:', error);
    res.status(500).json({ error: error.message || 'Import failed.' });
  }
};

module.exports = { getLeads, getLead, createLead, updateLead, deleteLead, addNote, addFollowup, getStages, getTodayFollowups, bulkUpdate, bulkDelete, importLeads, getImportTemplate };
