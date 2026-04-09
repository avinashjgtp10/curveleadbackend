const { query } = require('../config/db');

// GET /api/salary?month=MM&year=YYYY
const getSalaryOverview = async (req, res) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    const staff = await query(
      "SELECT * FROM staff_profiles WHERE tenant_id = $1 AND status = 'active' ORDER BY name", [req.tenantId]
    );

    const existingRecords = await query(
      'SELECT * FROM salary_records WHERE tenant_id = $1 AND month = $2 AND year = $3', [req.tenantId, month, year]
    );
    const recordMap = {};
    existingRecords.rows.forEach(r => { recordMap[r.staff_id] = r; });

    const results = [];
    for (const s of staff.rows) {
      // Get time logs for attendance
      const timeLogs = await query(
        `SELECT final_status, auto_status FROM staff_time_logs WHERE staff_id = $1 AND tenant_id = $2 AND TO_CHAR(date, 'YYYY-MM') = $3`,
        [s.id, req.tenantId, monthStr]
      );

      let present = 0, absent = 0, halfDay = 0;
      timeLogs.rows.forEach(t => {
        const status = t.final_status || t.auto_status;
        if (status === 'present') present++;
        else if (status === 'half_day') halfDay++;
        else if (status === 'absent') absent++;
      });

      // If no time logs, fallback to staff_attendance
      if (timeLogs.rows.length === 0) {
        const att = await query(
          `SELECT status, COUNT(*) as count FROM staff_attendance WHERE staff_id = $1 AND tenant_id = $2 AND TO_CHAR(date, 'YYYY-MM') = $3 GROUP BY status`,
          [s.id, req.tenantId, monthStr]
        );
        att.rows.forEach(a => {
          if (a.status === 'present') present = parseInt(a.count);
          else if (a.status === 'absent') absent = parseInt(a.count);
          else if (a.status === 'half_day') halfDay = parseInt(a.count);
        });
      }

      const deductionPerDay = parseFloat(s.deduction_per_day);
      const deductions = (absent * deductionPerDay) + (halfDay * deductionPerDay * 0.5);

      // Get incentives
      const incentives = await query(
        'SELECT COALESCE(SUM(amount), 0) as total FROM staff_incentives WHERE staff_id = $1 AND tenant_id = $2 AND month = $3 AND year = $4',
        [s.id, req.tenantId, month, year]
      );
      const incentiveTotal = parseFloat(incentives.rows[0].total);

      const existing = recordMap[s.id];
      const baseSalary = parseFloat(s.base_salary);
      const netSalary = baseSalary - deductions + incentiveTotal + (existing ? parseFloat(existing.bonus) : 0);

      results.push({
        staff_id: s.id, name: s.name, role: s.role, phone: s.phone,
        base_salary: baseSalary, deduction_per_day: deductionPerDay,
        working_days: present + absent + halfDay,
        days_present: present, days_absent: absent, days_half_day: halfDay,
        deductions, incentives: incentiveTotal,
        bonus: existing ? parseFloat(existing.bonus) : 0,
        net_salary: netSalary,
        payment_status: existing?.payment_status || 'pending',
        payment_date: existing?.payment_date || null,
        payment_mode: existing?.payment_mode || null,
        record_id: existing?.id || null,
      });
    }

    const totalSalary = results.reduce((s, r) => s + r.net_salary, 0);
    const totalPaid = results.filter(r => r.payment_status === 'paid').reduce((s, r) => s + r.net_salary, 0);

    res.json({
      month, year, staff: results,
      summary: { total: totalSalary, paid: totalPaid, pending: totalSalary - totalPaid, staffCount: results.length },
    });
  } catch (error) { console.error('Salary overview error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/salary/process
const processSalary = async (req, res) => {
  try {
    const { staff_id, month, year, working_days, days_present, days_absent, base_salary, deductions, bonus, incentives, net_salary, payment_mode, notes } = req.body;
    if (!staff_id || !month || !year) return res.status(400).json({ error: 'Staff, month, year required.' });

    const existing = await query(
      'SELECT id FROM salary_records WHERE staff_id = $1 AND month = $2 AND year = $3 AND tenant_id = $4',
      [staff_id, month, year, req.tenantId]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await query(
        `UPDATE salary_records SET working_days=$1, days_present=$2, days_absent=$3, base_salary=$4,
         deductions=$5, bonus=$6, net_salary=$7, payment_status='paid', payment_date=CURRENT_DATE,
         payment_mode=$8, notes=$9, created_by=$10 WHERE id=$11 AND tenant_id=$12 RETURNING *`,
        [working_days, days_present, days_absent, base_salary, deductions, bonus || 0, net_salary, payment_mode, notes, req.user.id, existing.rows[0].id, req.tenantId]
      );
    } else {
      result = await query(
        `INSERT INTO salary_records (tenant_id, staff_id, month, year, working_days, days_present, days_absent, base_salary, deductions, bonus, net_salary, payment_status, payment_date, payment_mode, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'paid',CURRENT_DATE,$12,$13,$14) RETURNING *`,
        [req.tenantId, staff_id, month, year, working_days, days_present, days_absent, base_salary, deductions, bonus || 0, net_salary, payment_mode, notes, req.user.id]
      );
    }
    res.json({ salary: result.rows[0] });
  } catch (error) { console.error('Process salary error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/salary/history
const getSalaryHistory = async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;
    const result = await query(
      `SELECT sr.month, sr.year, COUNT(*) as staff_count,
              COALESCE(SUM(sr.net_salary), 0) as total_salary,
              COUNT(CASE WHEN sr.payment_status = 'paid' THEN 1 END) as paid_count
       FROM salary_records sr WHERE sr.tenant_id = $1
       AND (sr.year * 12 + sr.month) >= (EXTRACT(YEAR FROM CURRENT_DATE) * 12 + EXTRACT(MONTH FROM CURRENT_DATE) - ${months})
       GROUP BY sr.month, sr.year ORDER BY sr.year DESC, sr.month DESC`, [req.tenantId]
    );
    res.json({ history: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getSalaryOverview, processSalary, getSalaryHistory };
