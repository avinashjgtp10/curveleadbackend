const { query, transaction } = require('../config/db');
const { computeFollowupHealth, MISSED_AFTER_HOURS, CRITICAL_AFTER_HOURS } = require('../utils/followupHealth');
const { computeLeadSla, TARGET_RESPONSE_MINUTES, ESCALATION_AFTER_MINUTES, MISSED_AFTER_MINUTES } = require('../utils/leadSla');
const { recordFirstResponse } = require('../utils/leadResponse');
const { nextLeadNumber, reserveLeadNumbers } = require('../utils/leadNumber');
const { createNotification } = require('./notificationController');

// GET /api/leads - with filters
const SORT_COLUMNS = {
  name: 'l.name',
  date: 'l.created_at',
  lead_id: 'l.lead_number',
  phone: 'l.phone',
  source: 'l.source',
  score: 'l.intent_score',
  stage: 'ls.pos',
  status: 'l.lead_status',
  assigned_to: 'u.name',
};

const getLeads = async (req, res) => {
  try {
    const { stage, lead_status, source, score, followup_health, sla_status, assigned_to, search, date_field, date_from, date_to, sort, dir, page = 1, limit = 20, hide_stages } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE l.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    // Staff can only see their own assigned leads
    if (req.user.role === 'staff') {
      whereClause += ` AND l.assigned_to = $${i++}`;
      params.push(req.user.id);
    }

    if (hide_stages) {
      const stagesToHide = hide_stages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (stagesToHide.length) {
        whereClause += ` AND NOT (LOWER(l.stage) = ANY($${i++}::text[]))`;
        params.push(stagesToHide);
      }
    }
    if (stage) { whereClause += ` AND LOWER(l.stage) = LOWER($${i++})`; params.push(stage); }
    if (lead_status) { whereClause += ` AND LOWER(l.lead_status) = LOWER($${i++})`; params.push(lead_status); }
    if (source) { whereClause += ` AND l.source = $${i++}`; params.push(source); }
    if (score) { whereClause += ` AND l.lead_score = $${i++}`; params.push(score); }
    // Follow-up Health — deterministic bucket computed from the lead's pending lead_followups row (pf.next_followup_at)
    if (followup_health === 'good') { whereClause += ` AND (pf.next_followup_at IS NULL OR pf.next_followup_at >= NOW())`; }
    else if (followup_health === 'delayed') { whereClause += ` AND pf.next_followup_at < NOW() AND pf.next_followup_at >= NOW() - INTERVAL '${MISSED_AFTER_HOURS} hours'`; }
    else if (followup_health === 'missed') { whereClause += ` AND pf.next_followup_at < NOW() - INTERVAL '${MISSED_AFTER_HOURS} hours' AND pf.next_followup_at >= NOW() - INTERVAL '${CRITICAL_AFTER_HOURS} hours'`; }
    else if (followup_health === 'critical') { whereClause += ` AND pf.next_followup_at < NOW() - INTERVAL '${CRITICAL_AFTER_HOURS} hours'`; }
    // Response SLA — deterministic bucket computed from created_at vs first_response_at
    if (sla_status === 'uncontacted') { whereClause += ` AND l.first_response_at IS NULL`; }
    else if (sla_status === 'new') { whereClause += ` AND l.first_response_at IS NULL AND l.created_at > NOW() - INTERVAL '${TARGET_RESPONSE_MINUTES} minutes'`; }
    else if (sla_status === 'sla_risk') { whereClause += ` AND l.first_response_at IS NULL AND l.created_at <= NOW() - INTERVAL '${TARGET_RESPONSE_MINUTES} minutes' AND l.created_at > NOW() - INTERVAL '${ESCALATION_AFTER_MINUTES} minutes'`; }
    else if (sla_status === 'sla_breached') { whereClause += ` AND l.first_response_at IS NULL AND l.created_at <= NOW() - INTERVAL '${ESCALATION_AFTER_MINUTES} minutes' AND l.created_at > NOW() - INTERVAL '${MISSED_AFTER_MINUTES} minutes'`; }
    else if (sla_status === 'missed_lead') { whereClause += ` AND l.first_response_at IS NULL AND l.created_at <= NOW() - INTERVAL '${MISSED_AFTER_MINUTES} minutes'`; }
    else if (sla_status === 'responded_5min') { whereClause += ` AND l.first_response_at IS NOT NULL AND l.response_time_seconds <= ${TARGET_RESPONSE_MINUTES * 60}`; }
    if (req.user.role !== 'staff') {
      if (assigned_to === 'unassigned') { whereClause += ` AND l.assigned_to IS NULL`; }
      else if (assigned_to) { whereClause += ` AND l.assigned_to = $${i++}`; params.push(assigned_to); }
    }
    if (search) {
      whereClause += ` AND (l.name ILIKE $${i} OR l.phone ILIKE $${i} OR l.lead_number ILIKE $${i})`;
      params.push(`%${search}%`);
      i++;
    }
    const dateColumn = date_field === 'created_at' ? 'l.created_at' : 'COALESCE(l.lead_date, l.created_at)';
    if (date_from) { whereClause += ` AND ${dateColumn} >= $${i++}`; params.push(date_from); }
    if (date_to) { whereClause += ` AND ${dateColumn} < $${i++}::date + INTERVAL '1 day'`; params.push(date_to); }

    const limitParam = i++;
    const offsetParam = i;
    params.push(limit, offset);

    // pf = the lead's current pending (not-completed) follow-up, if any — feeds both the
    // follow-up_health filter above and next_followup_at below.
    // ls = the lead's stage row, used only to sort by pipeline position (ls.pos) instead of alphabetically.
    const fromClause = `
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      LEFT JOIN campaigns c ON l.campaign_id = c.id
      LEFT JOIN lead_stages ls ON LOWER(ls.name) = LOWER(l.stage) AND ls.tenant_id = l.tenant_id
      LEFT JOIN LATERAL (
        SELECT next_followup_at, followup_type
        FROM lead_followups
        WHERE lead_id = l.id AND is_completed = false
        ORDER BY next_followup_at ASC
        LIMIT 1
      ) pf ON true
    `;

    const sortColumn = SORT_COLUMNS[sort] || 'l.created_at';
    const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
    const orderClause = sort
      ? `ORDER BY ${sortColumn} ${sortDir} NULLS LAST, l.created_at DESC`
      : 'ORDER BY l.created_at DESC';

    const leadsQuery = `
      SELECT l.*,
             u.name as assigned_to_name,
             c.name as campaign_name,
             c.source as campaign_source,
             pf.next_followup_at as next_followup_at,
             pf.followup_type as next_followup_type
      ${fromClause}
      ${whereClause}
      ${orderClause}
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const result = await query(leadsQuery, params);
    const countResult = await query(`SELECT COUNT(*) ${fromClause} ${whereClause}`, params.slice(0, -2));

    res.json({
      leads: result.rows.map(r => ({ ...r, ...computeLeadSla(r) })),
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

    const pendingFollowup = followups.rows.find(f => !f.is_completed) || null;

    res.json({
      lead: { ...result.rows[0], followup_health: computeFollowupHealth(pendingFollowup), ...computeLeadSla(result.rows[0]) },
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
      name, phone, email, location, business_name, address, source, source_detail, campaign_id,
      stage, notes, deal_value, expected_close_date, tags, lead_date,
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

    const result = await transaction(async (client) => {
      const leadNumber = await nextLeadNumber(req.tenantId, client);

      return client.query(
        `INSERT INTO leads (tenant_id, lead_number, name, phone, email, location, business_name, address, source, source_detail, campaign_id,
                            stage, assigned_to, notes, deal_value, expected_close_date, tags, lead_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING *`,
        [req.tenantId, leadNumber, name, phone, email, location, business_name, address, source || 'manual', source_detail, campaign_id,
         stage || 'new', assigned_to, notes, deal_value || 0, expected_close_date, tags, lead_date || new Date()]
      );
    });

    // Log activity
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
       VALUES ($1, $2, 'created', 'Lead created', $3)`,
      [req.tenantId, result.rows[0].id, req.user.id]
    );

    // Notify the assignee immediately — SLA clock starts now
    if (assigned_to && assigned_to !== req.user.id) {
      createNotification(
        req.tenantId, assigned_to, 'New lead assigned to you',
        `${name} — respond within 5 minutes to hit SLA`,
        'assignment', 'lead', result.rows[0].id
      ).catch(() => {});
    }

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
      'name', 'phone', 'email', 'location', 'business_name', 'address', 'source', 'source_detail', 'campaign_id',
      'stage', 'lead_status', 'assigned_to', 'notes', 'deal_value', 'expected_close_date',
      'tags', 'lead_score', 'score_reason', 'lost_reason', 'lead_date', 'advance_received',
    ];

    // Fetch current lead to capture prev values for history
    const current = await query(
      'SELECT stage, lead_status, assigned_to, name, advance_received FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!current.rows.length) return res.status(404).json({ error: 'Lead not found.' });
    const prev = current.rows[0];

    // Advance received is only collected once a lead is Won — check the
    // effective stage (the one being set in this request, or the current one).
    // Only enforce this when the value is actually changing — the edit form
    // resends the whole lead object, so advance_received is present on every
    // save even when the user is only editing an unrelated field.
    const advanceReceivedChanged = req.body.advance_received !== undefined
      && Number(req.body.advance_received) !== Number(prev.advance_received || 0);
    if (advanceReceivedChanged) {
      const effectiveStage = req.body.stage || prev.stage;
      const stageInfo = await query(
        'SELECT is_won FROM lead_stages WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
        [req.tenantId, effectiveStage]
      );
      if (!stageInfo.rows[0]?.is_won) {
        return res.status(400).json({ error: 'Advance received can only be set once the lead is marked Won.' });
      }
    }

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
      if (stageInfo.rows[0]?.is_lost) {
        updates.push('lost_at = NOW()');
        if (!req.body.lost_reason) {
          return res.status(400).json({ error: 'A reason is required when marking a lead as lost.', requires_lost_reason: true });
        }
      }
    }

    updates.push('updated_at = NOW()');

    const result = await query(
      `UPDATE leads SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found.' });

    const stageChanged  = req.body.stage       !== undefined && req.body.stage       !== prev.stage;
    const statusChanged = req.body.lead_status  !== undefined && req.body.lead_status  !== prev.lead_status;

    // Log to lead_stage_history when stage or status changes
    if (stageChanged || statusChanged) {
      await query(
        `INSERT INTO lead_stage_history
           (tenant_id, lead_id, prev_stage, new_stage, prev_status, new_status, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.tenantId, req.params.id,
          stageChanged  ? prev.stage       : null, stageChanged  ? req.body.stage       : null,
          statusChanged ? prev.lead_status  : null, statusChanged ? req.body.lead_status  : null,
          req.user.id,
        ]
      ).catch(() => {}); // non-blocking
    }

    // Log stage change to lead_activities
    if (stageChanged) {
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
         VALUES ($1, $2, 'stage_change', $3, $4)`,
        [req.tenantId, req.params.id, `Stage changed to ${req.body.stage}`, req.user.id]
      ).catch(() => {});
      if ((prev.stage || '').toLowerCase() === 'new') {
        recordFirstResponse(req.tenantId, req.params.id, { by: req.user.id, type: 'stage_change' }).catch(() => {});
      }
    }

    // Log status change to lead_activities
    if (statusChanged) {
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
         VALUES ($1, $2, 'status_change', $3, $4)`,
        [req.tenantId, req.params.id, `Status changed to ${req.body.lead_status}`, req.user.id]
      ).catch(() => {});
    }

    // Log source change
    if (req.body.source) {
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
         VALUES ($1, $2, 'source_change', $3, $4)`,
        [req.tenantId, req.params.id, `Source changed to ${req.body.source.replace(/_/g, ' ')}`, req.user.id]
      ).catch(() => {});
    }

    // Notify new assignee when assignment changes
    const assigneeChanged = req.body.assigned_to !== undefined
      && req.body.assigned_to
      && req.body.assigned_to !== prev.assigned_to;
    if (assigneeChanged) {
      await query(
        `INSERT INTO notifications (tenant_id, user_id, title, message, type, reference_type, reference_id)
         VALUES ($1, $2, 'Lead assigned to you', $3, 'assignment', 'lead', $4)`,
        [req.tenantId, req.body.assigned_to, `${result.rows[0].name} has been assigned to you`, req.params.id]
      ).catch(() => {});
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

// POST /api/leads/:id/call-click — fired when a user clicks a tel: link, counts as first response
const logCallClick = async (req, res) => {
  try {
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
       VALUES ($1, $2, 'call', 'Call Initiated', $3)`,
      [req.tenantId, req.params.id, req.user.id]
    ).catch(() => {});
    const lead = await recordFirstResponse(req.tenantId, req.params.id, { by: req.user.id, type: 'call' });
    res.json({ first_response_recorded: !!lead });
  } catch (error) {
    console.error('Log call click error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/leads/:id/mark-contacted — manual "first response" action
const markContacted = async (req, res) => {
  try {
    const lead = await recordFirstResponse(req.tenantId, req.params.id, { by: req.user.id, type: 'manual' });
    if (!lead) return res.status(409).json({ error: 'This lead has already been marked as contacted.' });
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
       VALUES ($1, $2, 'manual_contact', 'Marked as Contacted', $3)`,
      [req.tenantId, req.params.id, req.user.id]
    ).catch(() => {});
    res.json({ lead });
  } catch (error) {
    console.error('Mark contacted error:', error);
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
      'SELECT id, name, phone, email, assigned_to FROM leads WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (leadCheck.rows.length === 0) return res.status(404).json({ error: 'Lead not found.' });
    const lead = leadCheck.rows[0];

    const tenantRes = await query('SELECT name, settings FROM tenants WHERE id = $1', [req.tenantId]);
    const tenantName = tenantRes.rows[0]?.name || 'CurveLead';
    const tenantSettings = tenantRes.rows[0]?.settings || {};

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
    recordFirstResponse(req.tenantId, req.params.id, { by: req.user.id, type: isDemo ? 'demo_scheduled' : 'followup_scheduled' }).catch(() => {});

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

    // Auto-send WhatsApp confirmation on demo/visit booking
    const isAppointment = ['demo', 'visit'].includes((followup_type || '').toLowerCase());
    let whatsappSent = false;
    if (isAppointment && lead.phone) {
      try {
        const waCredentials = tenantSettings.whatsapp_phone_number_id ? {
          phone_number_id: tenantSettings.whatsapp_phone_number_id,
          access_token: tenantSettings.whatsapp_access_token,
        } : null;

        const label = isDemo ? 'demo' : 'visit/appointment';
        let msg = `Hi ${lead.name}, your ${label} with *${tenantName}* is confirmed for *${demoTime}*.`;
        if (meeting_url) msg += `\n\nJoin here: ${meeting_url}`;
        if (notes) msg += `\n\n_${notes}_`;

        const { sendTextMessage } = require('../services/whatsappService');
        const waRes = await sendTextMessage(lead.phone, msg, waCredentials);
        whatsappSent = waRes.success;
      } catch (e) {
        console.error('Auto WhatsApp error:', e.message);
      }
    }

    res.status(201).json({ followup: result.rows[0], emailSent: !!(isDemo && meeting_url && lead.email), whatsappSent });
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
      `SELECT l.*, u.name as assigned_to_name
       FROM leads l
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
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.tenantId, req.params.id, activity_type, title, description || null, req.user.id]
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

// GET /api/leads/duplicates - group leads by phone number, ignoring +91/0 prefixes
// and other formatting, so e.g. "9876543210" and "+91 98765 43210" are one group.
const getDuplicateLeads = async (req, res) => {
  try {
    const result = await query(
      `SELECT RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) AS norm_phone,
              json_agg(json_build_object(
                'id', id, 'lead_number', lead_number, 'name', name, 'phone', phone,
                'email', email, 'source', source, 'stage', stage, 'created_at', created_at
              ) ORDER BY created_at ASC) AS leads
       FROM leads
       WHERE tenant_id = $1
       GROUP BY norm_phone
       HAVING COUNT(*) > 1
       ORDER BY MIN(created_at) DESC`,
      [req.tenantId]
    );
    res.json({ groups: result.rows });
  } catch (error) {
    console.error('getDuplicateLeads error:', error);
    res.status(500).json({ error: 'Failed to find duplicate leads.' });
  }
};

// Every table that carries a lead_id gets its rows re-pointed at the kept lead
// before the duplicate row is deleted, so notes/calls/quotations aren't lost.
// students.lead_id has no ON DELETE action (RESTRICT), so leaving it out would
// make the DELETE below fail outright for any duplicate that was enrolled.
const DUPLICATE_LEAD_CHILD_TABLES = [
  'lead_activities', 'followups', 'lead_followups', 'lead_followup_attempts',
  'whatsapp_messages', 'lead_notes', 'lead_attachments', 'quotations',
  'brochure_shares', 'call_recordings', 'lead_stage_history', 'ai_voice_calls',
  'students',
];

// Nullable scalar columns on the lead itself worth carrying over from a removed
// duplicate when the kept lead's own value is blank.
const DUPLICATE_LEAD_FILL_COLUMNS = [
  'email', 'location', 'meta_lead_id', 'source_detail', 'business_name', 'address',
  'lead_status', 'intent_score', 'suggested_action', 'won_lost_reason', 'lost_reason',
  'expected_close_date', 'score_reason', 'course_interest_id',
];

// POST /api/leads/duplicates/merge - fold remove_ids into keep_id
const mergeDuplicateLeads = async (req, res) => {
  try {
    const { keep_id, remove_ids } = req.body;
    if (!keep_id || !Array.isArray(remove_ids) || !remove_ids.length) {
      return res.status(400).json({ error: 'keep_id and remove_ids are required.' });
    }
    if (remove_ids.includes(keep_id)) {
      return res.status(400).json({ error: 'keep_id cannot also appear in remove_ids.' });
    }

    const owned = await query(
      'SELECT id FROM leads WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
      [req.tenantId, [keep_id, ...remove_ids]]
    );
    if (owned.rows.length !== remove_ids.length + 1) {
      return res.status(404).json({ error: 'One or more leads not found.' });
    }

    await transaction(async (client) => {
      for (const table of DUPLICATE_LEAD_CHILD_TABLES) {
        await client.query(
          `UPDATE ${table} SET lead_id = $1 WHERE lead_id = ANY($2::uuid[])`,
          [keep_id, remove_ids]
        );
      }

      // Fill in any blanks on the kept lead — for each column, pull the most recent
      // non-null value among the duplicates being removed.
      const fillSet = DUPLICATE_LEAD_FILL_COLUMNS.map(col =>
        `${col} = COALESCE(k.${col}, (SELECT ${col} FROM leads WHERE id = ANY($2::uuid[]) AND ${col} IS NOT NULL ORDER BY created_at DESC LIMIT 1))`
      ).join(',\n           ');
      await client.query(
        `UPDATE leads k SET
           ${fillSet},
           deal_value = GREATEST(k.deal_value, (SELECT COALESCE(MAX(deal_value), 0) FROM leads WHERE id = ANY($2::uuid[]))),
           advance_received = GREATEST(k.advance_received, (SELECT COALESCE(MAX(advance_received), 0) FROM leads WHERE id = ANY($2::uuid[])))
         WHERE k.id = $1`,
        [keep_id, remove_ids]
      );

      // Append the removed duplicates' notes onto the kept lead rather than losing them
      await client.query(
        `UPDATE leads k SET
           notes = NULLIF(TRIM(BOTH E'\n' FROM CONCAT_WS(E'\n', NULLIF(TRIM(k.notes), ''), agg.notes)), '')
         FROM (
           SELECT string_agg(NULLIF(TRIM(notes), ''), E'\n') AS notes
           FROM leads WHERE id = ANY($2::uuid[])
         ) agg
         WHERE k.id = $1 AND agg.notes IS NOT NULL`,
        [keep_id, remove_ids]
      );

      // Union tags from the removed duplicates onto the kept lead
      await client.query(
        `UPDATE leads k SET tags = agg.tags
         FROM (
           SELECT ARRAY(SELECT DISTINCT unnest(tags) FROM leads WHERE id = ANY($1::uuid[])) AS tags
         ) agg
         WHERE k.id = $2 AND agg.tags IS NOT NULL AND array_length(agg.tags, 1) > 0`,
        [[keep_id, ...remove_ids], keep_id]
      );

      await client.query(
        'DELETE FROM leads WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [req.tenantId, remove_ids]
      );
    });

    res.json({ merged: remove_ids.length, kept: keep_id });
  } catch (error) {
    console.error('mergeDuplicateLeads error:', error);
    res.status(500).json({ error: 'Failed to merge duplicate leads.' });
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
      deal_value: ['deal_value','value','amount','deal_amount','price','budget','revenue','quoted_price','quote','quoted_amount'],
      city:       ['city','location','area','region'],
      lead_date:  ['lead_date','lead_datetime','lead_time','date','created_date','enquiry_date'],
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

    // Reserve a block of Lead IDs up front (one per row, worst case) and hand them
    // out in order as rows are actually inserted below.
    const getNextLeadNumber = await reserveLeadNumbers(req.tenantId, rows.length);

    let inserted = 0, skipped = 0;
    const errors = [];
    const skipReasons = [];

    const addSkip = (row, name, reason) => {
      skipped++;
      skipReasons.push({ row, name: name || '', reason });
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2;
      const lead = {};
      for (const [rawKey, field] of Object.entries(keyMap)) {
        lead[field] = String(row[rawKey] ?? '').trim();
      }

      // Require at least name
      if (!lead.name) { addSkip(rowNumber, '', 'Missing name'); continue; }

      // Normalise phone — strip non-digits, allow leading +
      if (lead.phone) lead.phone = lead.phone.replace(/[^\d+]/g, '').slice(0, 15);
      if (!lead.phone) { addSkip(rowNumber, lead.name, 'Missing phone'); continue; }

      // Validate/default stage
      const stageInput = (lead.stage || '').toLowerCase().trim();
      lead.stage = validStages.has(stageInput) ? stageInput : (validStages.has('new') ? 'new' : [...validStages][0] || 'new');

      // Parse deal value
      const dv = parseFloat(String(lead.deal_value).replace(/[^0-9.]/g, ''));
      lead.deal_value = isNaN(dv) ? null : dv;

      const leadNumber = getNextLeadNumber();

      try {
        const insertResult = await query(
          `INSERT INTO leads (tenant_id, lead_number, name, phone, email, source, stage, notes, deal_value, location, lead_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            req.tenantId,
            leadNumber,
            lead.name,
            lead.phone,
            lead.email || null,
            lead.source || 'import',
            lead.stage,
            lead.notes || null,
            lead.deal_value,
            lead.city || null,
            lead.lead_date || new Date(),
          ]
        );
        if (insertResult.rowCount > 0) inserted++;
        else addSkip(rowNumber, lead.name, `Duplicate phone: ${lead.phone}`);
      } catch (e) {
        errors.push({ row: rowNumber, name: lead.name, error: e.message });
        skipped++;
      }
    }

    res.json({
      message: `Import complete: ${inserted} leads added, ${skipped} skipped.`,
      inserted,
      skipped,
      errors: errors.slice(0, 20),
      skip_reasons: skipReasons.slice(0, 20),
    });
  } catch (error) {
    console.error('Import leads error:', error);
    res.status(500).json({ error: error.message || 'Import failed.' });
  }
};

// GET /api/leads/export — download all matching leads as CSV
const exportLeads = async (req, res) => {
  try {
    const { stage, lead_status, source, score, assigned_to, search, date_field, date_from, date_to } = req.query;

    let whereClause = 'WHERE l.tenant_id = $1';
    const params = [req.tenantId];
    let i = 2;

    if (req.user.role === 'staff') {
      whereClause += ` AND l.assigned_to = $${i++}`;
      params.push(req.user.id);
    }

    if (stage)       { whereClause += ` AND LOWER(l.stage) = LOWER($${i++})`;       params.push(stage); }
    if (lead_status) { whereClause += ` AND LOWER(l.lead_status) = LOWER($${i++})`; params.push(lead_status); }
    if (source)      { whereClause += ` AND l.source = $${i++}`;                    params.push(source); }
    if (score)       { whereClause += ` AND l.lead_score = $${i++}`;                params.push(score); }
    if (req.user.role !== 'staff') {
      if (assigned_to === 'unassigned') { whereClause += ` AND l.assigned_to IS NULL`; }
      else if (assigned_to)             { whereClause += ` AND l.assigned_to = $${i++}`; params.push(assigned_to); }
    }
    if (search) {
      whereClause += ` AND (l.name ILIKE $${i} OR l.phone ILIKE $${i})`;
      params.push(`%${search}%`);
      i++;
    }
    const dateCol = date_field === 'created_at' ? 'l.created_at' : 'COALESCE(l.lead_date, l.created_at)';
    if (date_from) { whereClause += ` AND ${dateCol} >= $${i++}`;                       params.push(date_from); }
    if (date_to)   { whereClause += ` AND ${dateCol} < $${i++}::date + INTERVAL '1 day'`; params.push(date_to); }

    const result = await query(
      `SELECT l.name, l.phone, l.email, l.location, l.source, l.stage, l.lead_status, l.lead_score,
              u.name as assigned_to_name, l.deal_value, l.notes, l.lost_reason,
              TO_CHAR(l.created_at, 'DD-MM-YYYY') as created_at,
              TO_CHAR(l.last_contacted_at, 'DD-MM-YYYY') as last_contacted_at
       FROM leads l
       LEFT JOIN users u ON l.assigned_to = u.id
       ${whereClause}
       ORDER BY l.created_at DESC
       LIMIT 10000`,
      params
    );

    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = ['Name','Phone','Email','Location','Source','Stage','Status','Score','Assigned To','Deal Value','Notes','Lost Reason','Created','Last Contacted'];
    const rows = result.rows.map(r =>
      [r.name,r.phone,r.email,r.location,r.source,r.stage,r.lead_status,r.lead_score,
       r.assigned_to_name,r.deal_value,r.notes,r.lost_reason,r.created_at,r.last_contacted_at]
      .map(esc).join(',')
    );

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads_export.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Export leads error:', error);
    res.status(500).json({ error: 'Failed to export leads.' });
  }
};

module.exports = { getLeads, getLead, createLead, updateLead, deleteLead, addNote, addFollowup, getStages, getTodayFollowups, bulkUpdate, bulkDelete, getDuplicateLeads, mergeDuplicateLeads, importLeads, getImportTemplate, getLeadStats, exportLeads, logCallClick, markContacted };
