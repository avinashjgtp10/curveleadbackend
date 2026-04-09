const { query } = require('../config/db');

// GET /api/expenses
const getExpenses = async (req, res) => {
  try {
    const { category_id, month, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = 'WHERE e.tenant_id = $1';
    const params = [req.tenantId];
    let pi = 2;

    if (category_id) { whereClause += ` AND e.category_id = $${pi++}`; params.push(category_id); }
    if (month) { whereClause += ` AND TO_CHAR(e.expense_date, 'YYYY-MM') = $${pi++}`; params.push(month); }

    const countResult = await query(`SELECT COUNT(*) FROM expenses e ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    const result = await query(
      `SELECT e.*, ec.name as category_name, u.name as created_by_name
       FROM expenses e LEFT JOIN expense_categories ec ON e.category_id = ec.id
       LEFT JOIN users u ON e.created_by = u.id
       ${whereClause} ORDER BY e.expense_date DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    // Month summary
    const currentMonth = month || new Date().toISOString().slice(0, 7);
    const summary = await query(
      `SELECT ec.name as category, COALESCE(SUM(e.amount), 0) as total
       FROM expenses e JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.tenant_id = $1 AND TO_CHAR(e.expense_date, 'YYYY-MM') = $2
       GROUP BY ec.name ORDER BY total DESC`,
      [req.tenantId, currentMonth]
    );

    const totalThisMonth = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE tenant_id = $1 AND TO_CHAR(expense_date, 'YYYY-MM') = $2`,
      [req.tenantId, currentMonth]
    );

    res.json({
      expenses: result.rows,
      categoryBreakdown: summary.rows,
      monthTotal: parseFloat(totalThisMonth.rows[0].total),
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) },
    });
  } catch (error) { console.error('Get expenses error:', error); res.status(500).json({ error: 'Failed to fetch expenses.' }); }
};

// GET /api/expenses/categories
const getCategories = async (req, res) => {
  try {
    const result = await query('SELECT * FROM expense_categories WHERE tenant_id = $1 ORDER BY name', [req.tenantId]);
    res.json({ categories: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch categories.' }); }
};

// POST /api/expenses/categories
const createCategory = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Category name required.' });
    const result = await query('INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING *', [req.tenantId, name]);
    res.status(201).json({ category: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed to create category.' }); }
};

// POST /api/expenses
const createExpense = async (req, res) => {
  try {
    const { category_id, description, amount, expense_date, payment_mode } = req.body;
    if (!category_id || !amount || !expense_date) return res.status(400).json({ error: 'Category, amount, and date are required.' });

    const result = await query(
      `INSERT INTO expenses (tenant_id, category_id, description, amount, expense_date, payment_mode, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.tenantId, category_id, description, parseFloat(amount), expense_date, payment_mode, req.user.id]
    );
    res.status(201).json({ expense: result.rows[0] });
  } catch (error) { console.error('Create expense error:', error); res.status(500).json({ error: 'Failed to add expense.' }); }
};

// PUT /api/expenses/:id
const updateExpense = async (req, res) => {
  try {
    const { category_id, description, amount, expense_date, payment_mode } = req.body;
    const result = await query(
      `UPDATE expenses SET category_id = COALESCE($1, category_id), description = COALESCE($2, description),
       amount = COALESCE($3, amount), expense_date = COALESCE($4, expense_date), payment_mode = COALESCE($5, payment_mode)
       WHERE id = $6 AND tenant_id = $7 RETURNING *`,
      [category_id, description, amount, expense_date, payment_mode, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Expense not found.' });
    res.json({ expense: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed to update expense.' }); }
};

// DELETE /api/expenses/:id
const deleteExpense = async (req, res) => {
  try {
    const result = await query('DELETE FROM expenses WHERE id = $1 AND tenant_id = $2 RETURNING id', [req.params.id, req.tenantId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Expense not found.' });
    res.json({ message: 'Expense deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed to delete expense.' }); }
};

// GET /api/expenses/report/monthly
const getMonthlyReport = async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;
    const result = await query(
      `SELECT TO_CHAR(expense_date, 'YYYY-MM') as month, COALESCE(SUM(amount), 0) as total
       FROM expenses WHERE tenant_id = $1 AND expense_date >= CURRENT_DATE - INTERVAL '${months} months'
       GROUP BY TO_CHAR(expense_date, 'YYYY-MM') ORDER BY month`,
      [req.tenantId]
    );

    const byCategory = await query(
      `SELECT ec.name as category, TO_CHAR(e.expense_date, 'YYYY-MM') as month, COALESCE(SUM(e.amount), 0) as total
       FROM expenses e JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.tenant_id = $1 AND e.expense_date >= CURRENT_DATE - INTERVAL '${months} months'
       GROUP BY ec.name, TO_CHAR(e.expense_date, 'YYYY-MM') ORDER BY month`,
      [req.tenantId]
    );

    res.json({ monthly: result.rows, byCategory: byCategory.rows });
  } catch (error) { res.status(500).json({ error: 'Failed to fetch report.' }); }
};

module.exports = { getExpenses, getCategories, createCategory, createExpense, updateExpense, deleteExpense, getMonthlyReport };
