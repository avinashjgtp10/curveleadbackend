const { query } = require('../config/db');

// A lead's status comes from its pipeline stage: the tenant's stage flagged is_won -> Converted,
// is_lost -> Lost, anything else -> Active. (Stage names are per-tenant, so match by name.)
const STATUS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT s.is_won, s.is_lost FROM lead_stages s
    WHERE s.tenant_id = l.tenant_id AND LOWER(s.name) = LOWER(l.stage) LIMIT 1
  ) st ON true`;
const STATUS_EXPR = `(CASE WHEN st.is_won THEN 'Converted' WHEN st.is_lost THEN 'Lost' ELSE 'Active' END)`;
const LAST_ACTIVITY_EXPR = `GREATEST(l.last_contacted_at, (SELECT MAX(a.created_at) FROM lead_activities a WHERE a.lead_id = l.id), l.updated_at)`;
const STATUS_VALUES = ['Active', 'Converted', 'Lost'];

// Builds the shared WHERE clause for the list and summary endpoints.
const buildFilters = (q) => {
  const conditions = [];
  const params = [];
  let i = 1;
  const add = (sql, value) => { conditions.push(sql.replace('$#', `$${i}`)); params.push(value); i++; };

  if (q.search) add('(l.name ILIKE $# OR l.phone ILIKE $# OR l.email ILIKE $#)', `%${q.search}%`);
  if (q.tenant_id) add('l.tenant_id = $#', q.tenant_id);
  if (q.source) add('l.source = $#', q.source);
  if (q.stage) add('LOWER(l.stage) = LOWER($#)', q.stage);
  if (q.score) add('l.lead_score = $#', q.score);
  if (q.assigned_to) add('l.assigned_to = $#', q.assigned_to);
  if (q.status && STATUS_VALUES.includes(q.status)) add(`${STATUS_EXPR} = $#`, q.status);
  const days = parseInt(q.days, 10);
  if (days > 0) add(`l.created_at >= NOW() - ($# || ' days')::INTERVAL`, String(days));
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params, next: i };
};

// GET /api/super-admin/leads?search&tenant_id&source&stage&score&assigned_to&status&days&page&limit
const getLeads = async (req, res) => {
  try {
    const { where, params, next } = buildFilters(req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const offset = (Math.max(parseInt(req.query.page, 10) || 1, 1) - 1) * limit;

    const [rows, count] = await Promise.all([
      query(
        `SELECT l.id, l.lead_number, l.name, l.phone, l.email, l.source, l.stage, l.lead_score, l.created_at,
                l.assigned_to, u.name AS assigned_to_name,
                t.id AS tenant_id, t.name AS tenant_name,
                ${STATUS_EXPR} AS status,
                ${LAST_ACTIVITY_EXPR} AS last_activity_at
         FROM leads l
         LEFT JOIN tenants t ON l.tenant_id = t.id
         LEFT JOIN users u ON l.assigned_to = u.id
         ${STATUS_JOIN}
         ${where}
         ORDER BY l.created_at DESC
         LIMIT $${next} OFFSET $${next + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) FROM leads l ${STATUS_JOIN} ${where}`, params),
    ]);
    res.json({ leads: rows.rows, total: parseInt(count.rows[0].count, 10) });
  } catch (error) {
    console.error('Get cross-tenant leads error:', error);
    res.status(500).json({ error: 'Failed.' });
  }
};

// GET /api/super-admin/leads/summary — exact counts, no sampling.
const getLeadsSummary = async (req, res) => {
  try {
    const [totals, orgs, users] = await Promise.all([
      query(`SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE ${STATUS_EXPR} = 'Active') AS active,
                    COUNT(*) FILTER (WHERE ${STATUS_EXPR} = 'Converted') AS converted,
                    COUNT(*) FILTER (WHERE ${STATUS_EXPR} = 'Lost') AS lost
             FROM leads l ${STATUS_JOIN}`),
      query(`SELECT t.id, t.name,
                    COUNT(l.id) AS total,
                    COUNT(l.id) FILTER (WHERE ${STATUS_EXPR} = 'Active') AS active,
                    COUNT(l.id) FILTER (WHERE ${STATUS_EXPR} = 'Converted') AS converted,
                    COUNT(l.id) FILTER (WHERE ${STATUS_EXPR} = 'Lost') AS lost
             FROM tenants t
             LEFT JOIN leads l ON l.tenant_id = t.id
             ${STATUS_JOIN}
             GROUP BY t.id, t.name ORDER BY total DESC, t.name`),
      query(`SELECT u.id, u.name, u.role, t.id AS tenant_id, t.name AS tenant_name, COUNT(l.id) AS leads
             FROM leads l
             JOIN users u ON u.id = l.assigned_to
             LEFT JOIN tenants t ON t.id = u.tenant_id
             GROUP BY u.id, u.name, u.role, t.id, t.name ORDER BY leads DESC, u.name`),
    ]);
    const n = (v) => parseInt(v, 10) || 0;
    const t = totals.rows[0];
    res.json({
      totals: { total: n(t.total), active: n(t.active), converted: n(t.converted), lost: n(t.lost) },
      organizations: orgs.rows.map(o => ({ id: o.id, name: o.name, total: n(o.total), active: n(o.active), converted: n(o.converted), lost: n(o.lost) })),
      users: users.rows.map(u => ({ id: u.id, name: u.name, role: u.role, tenant_id: u.tenant_id, tenant_name: u.tenant_name, leads: n(u.leads) })),
    });
  } catch (error) {
    console.error('Leads summary error:', error);
    res.status(500).json({ error: 'Failed to load the leads summary.' });
  }
};

// GET /api/super-admin/leads/:id/activity — the lead's timeline: recorded activities plus notes.
const getLeadActivity = async (req, res) => {
  try {
    const lead = await query('SELECT id FROM leads WHERE id = $1', [req.params.id]);
    if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found.' });

    const activities = await query(
      `SELECT a.id, a.activity_type AS type, a.title, a.description, a.created_at, u.name AS created_by_name
       FROM lead_activities a LEFT JOIN users u ON u.id = a.created_by
       WHERE a.lead_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [req.params.id]
    );
    let notes = [];
    try {
      notes = (await query(
        `SELECT n.id, 'note' AS type, 'Note added' AS title, n.note AS description, n.created_at, u.name AS created_by_name
         FROM lead_notes n LEFT JOIN users u ON u.id = n.created_by
         WHERE n.lead_id = $1 ORDER BY n.created_at DESC LIMIT 50`, [req.params.id]
      )).rows;
    } catch (e) { if (e.code !== '42P01') throw e; }

    const timeline = [...activities.rows, ...notes]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 50);
    res.json({ activity: timeline });
  } catch (error) {
    console.error('Lead activity error:', error);
    res.status(500).json({ error: 'Failed to load lead activity.' });
  }
};

module.exports = { getLeads, getLeadsSummary, getLeadActivity };
