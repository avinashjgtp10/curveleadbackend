const { query } = require('../config/db');

// GET /api/reports/pnl?view=monthly|quarterly|yearly&fy=2025
const getPnL = async (req, res) => {
  try {
    const view = req.query.view || 'monthly';
    const fy = parseInt(req.query.fy) || new Date().getFullYear();
    // Indian FY: April to March. FY 2025 = Apr 2025 to Mar 2026
    const fyStart = `${fy}-04-01`;
    const fyEnd = `${fy + 1}-03-31`;

    // Revenue collected by month
    const revenue = await query(
      `SELECT TO_CHAR(payment_date, 'YYYY-MM') as month, COALESCE(SUM(amount), 0) as collected
       FROM payments WHERE tenant_id = $1 AND payment_date >= $2 AND payment_date <= $3
       GROUP BY TO_CHAR(payment_date, 'YYYY-MM') ORDER BY month`,
      [req.tenantId, fyStart, fyEnd]
    );

    // Revenue booked by enrollment month
    const booked = await query(
      `SELECT TO_CHAR(s.enrollment_date, 'YYYY-MM') as month, COALESCE(SUM(sf.net_fee), 0) as booked
       FROM student_fees sf JOIN students s ON sf.student_id = s.id
       WHERE sf.tenant_id = $1 AND s.enrollment_date >= $2 AND s.enrollment_date <= $3
       GROUP BY TO_CHAR(s.enrollment_date, 'YYYY-MM') ORDER BY month`,
      [req.tenantId, fyStart, fyEnd]
    );

    // Expenses by month
    const expenses = await query(
      `SELECT TO_CHAR(expense_date, 'YYYY-MM') as month, COALESCE(SUM(amount), 0) as total
       FROM expenses WHERE tenant_id = $1 AND expense_date >= $2 AND expense_date <= $3
       GROUP BY TO_CHAR(expense_date, 'YYYY-MM') ORDER BY month`,
      [req.tenantId, fyStart, fyEnd]
    );

    // Salaries by month
    const salaries = await query(
      `SELECT CONCAT(year, '-', LPAD(month::text, 2, '0')) as month, COALESCE(SUM(net_salary), 0) as total
       FROM salary_records WHERE tenant_id = $1
       AND CONCAT(year, '-', LPAD(month::text, 2, '0'), '-01')::date >= $2::date
       AND CONCAT(year, '-', LPAD(month::text, 2, '0'), '-01')::date <= $3::date
       GROUP BY year, month ORDER BY month`,
      [req.tenantId, fyStart, fyEnd]
    );

    // Expense breakdown by category for the FY
    const expenseByCategory = await query(
      `SELECT ec.name as category, COALESCE(SUM(e.amount), 0) as total
       FROM expenses e JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.tenant_id = $1 AND e.expense_date >= $2 AND e.expense_date <= $3
       GROUP BY ec.name ORDER BY total DESC`,
      [req.tenantId, fyStart, fyEnd]
    );

    // Build monthly data
    const monthMap = {};
    // Generate all months in FY
    for (let m = 4; m <= 15; m++) {
      const actualMonth = m > 12 ? m - 12 : m;
      const actualYear = m > 12 ? fy + 1 : fy;
      const key = `${actualYear}-${String(actualMonth).padStart(2, '0')}`;
      monthMap[key] = { month: key, booked: 0, collected: 0, expenses: 0, salaries: 0, profit: 0 };
    }

    booked.rows.forEach(r => { if (monthMap[r.month]) monthMap[r.month].booked = parseFloat(r.booked); });
    revenue.rows.forEach(r => { if (monthMap[r.month]) monthMap[r.month].collected = parseFloat(r.collected); });
    expenses.rows.forEach(r => { if (monthMap[r.month]) monthMap[r.month].expenses = parseFloat(r.total); });
    salaries.rows.forEach(r => { if (monthMap[r.month]) monthMap[r.month].salaries = parseFloat(r.total); });

    const monthlyData = Object.values(monthMap).map(m => ({
      ...m,
      profit: m.collected - m.expenses - m.salaries,
    }));

    let result;
    if (view === 'quarterly') {
      const quarters = [
        { label: 'Q1 (Apr-Jun)', months: monthlyData.slice(0, 3) },
        { label: 'Q2 (Jul-Sep)', months: monthlyData.slice(3, 6) },
        { label: 'Q3 (Oct-Dec)', months: monthlyData.slice(6, 9) },
        { label: 'Q4 (Jan-Mar)', months: monthlyData.slice(9, 12) },
      ];

      result = quarters.map(q => ({
        period: q.label,
        booked: q.months.reduce((s, m) => s + m.booked, 0),
        collected: q.months.reduce((s, m) => s + m.collected, 0),
        expenses: q.months.reduce((s, m) => s + m.expenses, 0),
        salaries: q.months.reduce((s, m) => s + m.salaries, 0),
        profit: q.months.reduce((s, m) => s + m.profit, 0),
      }));
    } else if (view === 'yearly') {
      result = [{
        period: `FY ${fy}-${String(fy + 1).slice(2)}`,
        booked: monthlyData.reduce((s, m) => s + m.booked, 0),
        collected: monthlyData.reduce((s, m) => s + m.collected, 0),
        expenses: monthlyData.reduce((s, m) => s + m.expenses, 0),
        salaries: monthlyData.reduce((s, m) => s + m.salaries, 0),
        profit: monthlyData.reduce((s, m) => s + m.profit, 0),
      }];
    } else {
      result = monthlyData.map(m => ({ ...m, period: m.month }));
    }

    // Totals
    const totals = {
      booked: monthlyData.reduce((s, m) => s + m.booked, 0),
      collected: monthlyData.reduce((s, m) => s + m.collected, 0),
      expenses: monthlyData.reduce((s, m) => s + m.expenses, 0),
      salaries: monthlyData.reduce((s, m) => s + m.salaries, 0),
      profit: monthlyData.reduce((s, m) => s + m.profit, 0),
    };

    res.json({
      view, fy, fyLabel: `FY ${fy}-${String(fy + 1).slice(2)}`,
      data: result, totals, monthlyData,
      expenseByCategory: expenseByCategory.rows,
    });
  } catch (error) { console.error('P&L error:', error); res.status(500).json({ error: 'Failed to fetch P&L report.' }); }
};

// GET /api/reports/summary - Quick summary for reports page
const getSummary = async (req, res) => {
  try {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const revenue = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE tenant_id = $1 AND TO_CHAR(payment_date, 'YYYY-MM') = $2`,
      [req.tenantId, thisMonth]
    );
    const expenses = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE tenant_id = $1 AND TO_CHAR(expense_date, 'YYYY-MM') = $2`,
      [req.tenantId, thisMonth]
    );
    const salaries = await query(
      `SELECT COALESCE(SUM(net_salary), 0) as total FROM salary_records WHERE tenant_id = $1 AND month = $2 AND year = $3`,
      [req.tenantId, now.getMonth() + 1, now.getFullYear()]
    );
    const students = await query("SELECT COUNT(*) FROM students WHERE tenant_id = $1 AND status = 'active'", [req.tenantId]);
    const leads = await query(
      `SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)`, [req.tenantId]
    );

    const rev = parseFloat(revenue.rows[0].total);
    const exp = parseFloat(expenses.rows[0].total);
    const sal = parseFloat(salaries.rows[0].total);

    res.json({
      thisMonth: { revenue: rev, expenses: exp, salaries: sal, profit: rev - exp - sal },
      activeStudents: parseInt(students.rows[0].count),
      leadsThisMonth: parseInt(leads.rows[0].count),
    });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getPnL, getSummary };
