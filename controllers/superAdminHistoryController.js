const { query } = require('../config/db');

const paging = (q) => {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { limit, offset: (page - 1) * limit };
};

// A history table that has not been migrated yet is an empty history, not an error.
const run = async (res, label, fn) => {
  try { res.json(await fn()); }
  catch (e) {
    if (e.code === '42P01') return res.json({ history: [], total: 0, needs_migration: true });
    console.error(`${label} error:`, e);
    res.status(500).json({ error: `Failed to load ${label}.` });
  }
};

// GET /api/super-admin/history/deletions?search=&type=user|organization&page=&limit=
const getDeletionHistory = (req, res) => run(res, 'deletion history', async () => {
  const { search, type } = req.query;
  const { limit, offset } = paging(req.query);
  const conditions = [];
  const params = [];
  let i = 1;
  if (search) { conditions.push(`(name ILIKE $${i} OR email ILIKE $${i} OR tenant_name ILIKE $${i})`); params.push(`%${search}%`); i++; }
  if (type === 'user' || type === 'organization') { conditions.push(`account_type = $${i}`); params.push(type); i++; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows, count] = await Promise.all([
    query(`SELECT id, account_type, name, email, role, tenant_name, deleted_by_name, deleted_by_email, reason, deleted_at
           FROM account_deletion_history ${where} ORDER BY deleted_at DESC LIMIT $${i} OFFSET $${i + 1}`, [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM account_deletion_history ${where}`, params),
  ]);
  return { history: rows.rows, total: parseInt(count.rows[0].count, 10) };
});

// GET /api/super-admin/history/cleanups?search=&page=&limit=
const getCleanupHistory = (req, res) => run(res, 'clean-up history', async () => {
  const { search } = req.query;
  const { limit, offset } = paging(req.query);
  const params = [];
  let where = '';
  if (search) { where = 'WHERE (tenant_name ILIKE $1 OR owner_email ILIKE $1)'; params.push(`%${search}%`); }
  const n = params.length;
  const [rows, count] = await Promise.all([
    query(`SELECT id, tenant_name, owner_email, cleared_by_name, cleared_by_email, reason, cleared_at
           FROM account_cleanup_history ${where} ORDER BY cleared_at DESC LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, limit, offset]),
    query(`SELECT COUNT(*) FROM account_cleanup_history ${where}`, params),
  ]);
  return { history: rows.rows, total: parseInt(count.rows[0].count, 10) };
});

module.exports = { getDeletionHistory, getCleanupHistory };
