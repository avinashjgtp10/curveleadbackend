const { query } = require('../config/db');

// GET /api/dashboard
const getDashboard = async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Lead stats
    const totalLeads = await query(
      `SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)`,
      [tenantId]
    );

    const leadsByStage = await query(
      `SELECT stage, COUNT(*) as count FROM leads WHERE tenant_id = $1 GROUP BY stage`,
      [tenantId]
    );

    const totalAllLeads = await query('SELECT COUNT(*) FROM leads WHERE tenant_id = $1', [tenantId]);
    const enrolledLeads = await query("SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND stage = 'enrolled'", [tenantId]);
    const total = parseInt(totalAllLeads.rows[0].count);
    const enrolled = parseInt(enrolledLeads.rows[0].count);
    const conversionRate = total > 0 ? ((enrolled / total) * 100).toFixed(1) : 0;

    // Follow-up stats
    const todayFollowups = await query(
      `SELECT COUNT(*) FROM lead_followups 
       WHERE tenant_id = $1 AND is_completed = false AND DATE(next_followup_at) = CURRENT_DATE`,
      [tenantId]
    );

    const overdueFollowups = await query(
      `SELECT COUNT(*) FROM lead_followups 
       WHERE tenant_id = $1 AND is_completed = false AND next_followup_at < CURRENT_TIMESTAMP`,
      [tenantId]
    );

    // Student stats
    const activeStudents = await query(
      "SELECT COUNT(*) FROM students WHERE tenant_id = $1 AND status = 'active'",
      [tenantId]
    );

    const newEnrollments = await query(
      `SELECT COUNT(*) FROM students 
       WHERE tenant_id = $1 AND enrollment_date >= date_trunc('month', CURRENT_DATE)`,
      [tenantId]
    );

    // Revenue this month
    const monthRevenue = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM payments 
       WHERE tenant_id = $1 AND payment_date >= date_trunc('month', CURRENT_DATE)`,
      [tenantId]
    );

    // Pending fees
    const pendingFees = await query(
      `SELECT COALESCE(SUM(balance), 0) as total FROM student_fees 
       WHERE tenant_id = $1 AND status IN ('pending', 'partial', 'overdue')`,
      [tenantId]
    );

    // Expenses this month
    const monthExpenses = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses 
       WHERE tenant_id = $1 AND expense_date >= date_trunc('month', CURRENT_DATE)`,
      [tenantId]
    );

    // Salaries this month
    const monthSalaries = await query(
      `SELECT COALESCE(SUM(net_salary), 0) as total FROM salary_records 
       WHERE tenant_id = $1 AND month = EXTRACT(MONTH FROM CURRENT_DATE) 
       AND year = EXTRACT(YEAR FROM CURRENT_DATE)`,
      [tenantId]
    );

    const revenue = parseFloat(monthRevenue.rows[0].total);
    const expenses = parseFloat(monthExpenses.rows[0].total);
    const salaries = parseFloat(monthSalaries.rows[0].total);

    // Overdue fee reminders
    const overduePayments = await query(
      `SELECT s.name as student_name, s.phone, sf.balance, fi.due_date, fi.amount as installment_amount
       FROM fee_installments fi
       JOIN student_fees sf ON fi.student_fee_id = sf.id
       JOIN students s ON sf.student_id = s.id
       WHERE fi.tenant_id = $1 AND fi.status = 'pending' AND fi.due_date < CURRENT_DATE
       ORDER BY fi.due_date ASC
       LIMIT 10`,
      [tenantId]
    );

    res.json({
      leads: {
        thisMonth: parseInt(totalLeads.rows[0].count),
        byStage: leadsByStage.rows,
        conversionRate: parseFloat(conversionRate),
        todayFollowups: parseInt(todayFollowups.rows[0].count),
        overdueFollowups: parseInt(overdueFollowups.rows[0].count),
      },
      students: {
        active: parseInt(activeStudents.rows[0].count),
        newThisMonth: parseInt(newEnrollments.rows[0].count),
      },
      finance: {
        monthRevenue: revenue,
        pendingFees: parseFloat(pendingFees.rows[0].total),
        monthExpenses: expenses,
        monthSalaries: salaries,
        netProfit: revenue - expenses - salaries,
      },
      overduePayments: overduePayments.rows,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data.' });
  }
};

module.exports = { getDashboard };
