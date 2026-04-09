const { query } = require('../config/db');
const bcrypt = require('bcryptjs');

// GET /api/staff
const getStaff = async (req, res) => {
  try {
    const result = await query(
      `SELECT sp.*, u.email, u.is_active as user_active, u.last_login
       FROM staff_profiles sp LEFT JOIN users u ON sp.user_id = u.id
       WHERE sp.tenant_id = $1 ORDER BY sp.name`, [req.tenantId]
    );
    res.json({ staff: result.rows });
  } catch (error) { console.error('Get staff error:', error); res.status(500).json({ error: 'Failed to fetch staff.' }); }
};

// GET /api/staff/:id - Full staff detail with time logs, attendance, salary, incentives
const getStaffDetail = async (req, res) => {
  try {
    const month = req.query.month || new Date().getMonth() + 1;
    const year = req.query.year || new Date().getFullYear();
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    const staff = await query(
      `SELECT sp.*, u.email, u.is_active as user_active FROM staff_profiles sp
       LEFT JOIN users u ON sp.user_id = u.id WHERE sp.id = $1 AND sp.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (staff.rows.length === 0) return res.status(404).json({ error: 'Staff not found.' });

    // Get tenant settings
    const tenant = await query('SELECT grace_period_minutes FROM tenants WHERE id = $1', [req.tenantId]);
    const gracePeriod = tenant.rows[0]?.grace_period_minutes || 15;

    // Time logs for selected month
    const timeLogs = await query(
      `SELECT * FROM staff_time_logs WHERE staff_id = $1 AND tenant_id = $2
       AND TO_CHAR(date, 'YYYY-MM') = $3 ORDER BY date`, [req.params.id, req.tenantId, monthStr]
    );

    // Attendance summary
    const attSummary = { present: 0, half_day: 0, absent: 0, leave: 0, late_count: 0 };
    timeLogs.rows.forEach(t => {
      const status = t.final_status || t.auto_status;
      if (attSummary[status] !== undefined) attSummary[status]++;
      if (t.late_by_minutes > 0) attSummary.late_count++;
    });

    // Salary history
    const salaryHistory = await query(
      'SELECT * FROM salary_records WHERE staff_id = $1 AND tenant_id = $2 ORDER BY year DESC, month DESC LIMIT 12',
      [req.params.id, req.tenantId]
    );

    // Incentives for selected month
    const incentives = await query(
      'SELECT * FROM staff_incentives WHERE staff_id = $1 AND tenant_id = $2 AND month = $3 AND year = $4 ORDER BY created_at',
      [req.params.id, req.tenantId, month, year]
    );

    const totalIncentives = incentives.rows.reduce((s, i) => s + parseFloat(i.amount), 0);

    // Calculate salary for this month
    const staffData = staff.rows[0];
    const baseSalary = parseFloat(staffData.base_salary);
    const deductionPerDay = parseFloat(staffData.deduction_per_day);
    const deductions = (attSummary.absent * deductionPerDay) + (attSummary.half_day * deductionPerDay * 0.5);
    const netSalary = baseSalary - deductions + totalIncentives;

    res.json({
      staff: staffData,
      gracePeriod,
      timeLogs: timeLogs.rows,
      attendanceSummary: attSummary,
      salaryHistory: salaryHistory.rows,
      incentives: incentives.rows,
      totalIncentives,
      currentMonthSalary: { baseSalary, deductions, incentives: totalIncentives, netSalary },
      month: parseInt(month), year: parseInt(year),
    });
  } catch (error) { console.error('Get staff detail error:', error); res.status(500).json({ error: 'Failed to fetch staff details.' }); }
};

// POST /api/staff
const createStaff = async (req, res) => {
  try {
    const { name, phone, email, password, role, base_salary, deduction_per_day, join_date, shift_start_time } = req.body;
    if (!name || !phone || !base_salary) return res.status(400).json({ error: 'Name, phone, and base salary are required.' });

    let userId = null;
    if (email && password) {
      const existing = await query('SELECT id FROM users WHERE email = $1 AND tenant_id = $2', [email, req.tenantId]);
      if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already exists.' });
      const hash = await bcrypt.hash(password, 12);
      const userResult = await query(
        `INSERT INTO users (tenant_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,'staff') RETURNING id`,
        [req.tenantId, name, email, phone, hash]
      );
      userId = userResult.rows[0].id;
    }

    const result = await query(
      `INSERT INTO staff_profiles (tenant_id, user_id, name, phone, role, base_salary, deduction_per_day, join_date, shift_start_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.tenantId, userId, name, phone, role || 'Staff', parseFloat(base_salary), parseFloat(deduction_per_day) || 0, join_date || new Date(), shift_start_time || '10:00']
    );
    res.status(201).json({ staff: result.rows[0], hasLogin: !!userId });
  } catch (error) { console.error('Create staff error:', error); res.status(500).json({ error: 'Failed to add staff.' }); }
};

// PUT /api/staff/:id
const updateStaff = async (req, res) => {
  try {
    const { name, phone, role, base_salary, deduction_per_day, status, shift_start_time } = req.body;
    const result = await query(
      `UPDATE staff_profiles SET name=COALESCE($1,name), phone=COALESCE($2,phone), role=COALESCE($3,role),
       base_salary=COALESCE($4,base_salary), deduction_per_day=COALESCE($5,deduction_per_day),
       status=COALESCE($6,status), shift_start_time=COALESCE($7,shift_start_time)
       WHERE id=$8 AND tenant_id=$9 RETURNING *`,
      [name, phone, role, base_salary, deduction_per_day, status, shift_start_time, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Staff not found.' });
    if (status === 'inactive' && result.rows[0].user_id) {
      await query('UPDATE users SET is_active = false WHERE id = $1', [result.rows[0].user_id]);
    }
    res.json({ staff: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed to update staff.' }); }
};

// POST /api/staff/check-in - Record check-in time
const checkIn = async (req, res) => {
  try {
    const { staff_id, date, check_in, check_out, notes } = req.body;
    if (!staff_id || !date || !check_in) return res.status(400).json({ error: 'Staff, date, and check-in time required.' });

    // Get staff shift time and tenant grace period
    const staffResult = await query('SELECT shift_start_time FROM staff_profiles WHERE id = $1 AND tenant_id = $2', [staff_id, req.tenantId]);
    if (staffResult.rows.length === 0) return res.status(404).json({ error: 'Staff not found.' });

    const tenantResult = await query('SELECT grace_period_minutes FROM tenants WHERE id = $1', [req.tenantId]);
    const gracePeriod = tenantResult.rows[0]?.grace_period_minutes || 15;
    const shiftStart = staffResult.rows[0].shift_start_time;

    // Calculate late minutes
    const shiftParts = shiftStart.split(':');
    const checkParts = check_in.split(':');
    const shiftMinutes = parseInt(shiftParts[0]) * 60 + parseInt(shiftParts[1]);
    const checkMinutes = parseInt(checkParts[0]) * 60 + parseInt(checkParts[1]);
    const lateBy = Math.max(0, checkMinutes - shiftMinutes);

    // Auto determine status
    let autoStatus = 'present';
    if (lateBy > gracePeriod) autoStatus = 'half_day';

    const result = await query(
      `INSERT INTO staff_time_logs (tenant_id, staff_id, date, check_in, check_out, late_by_minutes, auto_status, final_status, notes, marked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)
       ON CONFLICT (staff_id, date) DO UPDATE SET check_in=$4, check_out=$5, late_by_minutes=$6, auto_status=$7, final_status=$7, notes=$8
       RETURNING *`,
      [req.tenantId, staff_id, date, check_in, check_out || null, lateBy, autoStatus, notes, req.user.id]
    );

    // Also update staff_attendance table for salary calculation
    const finalStatus = autoStatus === 'half_day' ? 'half_day' : 'present';
    await query(
      `INSERT INTO staff_attendance (tenant_id, staff_id, date, status)
       VALUES ($1,$2,$3,$4) ON CONFLICT (staff_id, date) DO UPDATE SET status = $4`,
      [req.tenantId, staff_id, date, finalStatus]
    );

    res.json({
      timeLog: result.rows[0],
      lateBy,
      status: autoStatus,
      message: lateBy > gracePeriod ? `Late by ${lateBy} min — marked as Half Day` : lateBy > 0 ? `Late by ${lateBy} min — within grace period` : 'On time',
    });
  } catch (error) { console.error('Check-in error:', error); res.status(500).json({ error: 'Failed to record check-in.' }); }
};

// POST /api/staff/check-out
const checkOut = async (req, res) => {
  try {
    const { staff_id, date, check_out } = req.body;
    await query(
      'UPDATE staff_time_logs SET check_out = $1 WHERE staff_id = $2 AND date = $3 AND tenant_id = $4',
      [check_out, staff_id, date, req.tenantId]
    );
    res.json({ message: 'Check-out recorded.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/staff/time-logs/:id/override - Admin override status
const overrideStatus = async (req, res) => {
  try {
    const { final_status, notes } = req.body;
    const result = await query(
      'UPDATE staff_time_logs SET final_status = $1, notes = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *',
      [final_status, notes, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Time log not found.' });

    // Update staff_attendance too
    const log = result.rows[0];
    await query(
      `INSERT INTO staff_attendance (tenant_id, staff_id, date, status)
       VALUES ($1,$2,$3,$4) ON CONFLICT (staff_id, date) DO UPDATE SET status = $4`,
      [req.tenantId, log.staff_id, log.date, final_status]
    );

    res.json({ timeLog: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/staff/time-logs?date=YYYY-MM-DD - All staff time logs for a date
const getTimeLogs = async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const allStaff = await query(
      "SELECT id, name, role, phone, shift_start_time FROM staff_profiles WHERE tenant_id = $1 AND status = 'active' ORDER BY name",
      [req.tenantId]
    );

    const logs = await query(
      'SELECT * FROM staff_time_logs WHERE tenant_id = $1 AND date = $2', [req.tenantId, date]
    );
    const logMap = {};
    logs.rows.forEach(l => { logMap[l.staff_id] = l; });

    const tenant = await query('SELECT grace_period_minutes FROM tenants WHERE id = $1', [req.tenantId]);
    const gracePeriod = tenant.rows[0]?.grace_period_minutes || 15;

    const result = allStaff.rows.map(s => ({
      ...s,
      timeLog: logMap[s.id] || null,
      check_in: logMap[s.id]?.check_in || null,
      check_out: logMap[s.id]?.check_out || null,
      late_by_minutes: logMap[s.id]?.late_by_minutes || 0,
      status: logMap[s.id]?.final_status || logMap[s.id]?.auto_status || null,
    }));

    res.json({ date, gracePeriod, staff: result });
  } catch (error) { console.error('Get time logs error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/staff/incentives - Add incentive
const addIncentive = async (req, res) => {
  try {
    const { staff_id, month, year, amount, reason } = req.body;
    if (!staff_id || !month || !year || !amount || !reason) return res.status(400).json({ error: 'All fields required.' });

    const result = await query(
      `INSERT INTO staff_incentives (tenant_id, staff_id, month, year, amount, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.tenantId, staff_id, month, year, parseFloat(amount), reason, req.user.id]
    );
    res.status(201).json({ incentive: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed to add incentive.' }); }
};

// DELETE /api/staff/incentives/:id
const deleteIncentive = async (req, res) => {
  try {
    await query('DELETE FROM staff_incentives WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    res.json({ message: 'Incentive deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/staff/trainers - Get staff with role Trainer (for batch dropdown)
const getTrainers = async (req, res) => {
  try {
    const result = await query(
      "SELECT id, name, phone FROM staff_profiles WHERE tenant_id = $1 AND status = 'active' AND role = 'Trainer' ORDER BY name",
      [req.tenantId]
    );
    res.json({ trainers: result.rows });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/staff/settings - Update grace period
const updateSettings = async (req, res) => {
  try {
    const { grace_period_minutes } = req.body;
    await query('UPDATE tenants SET grace_period_minutes = $1 WHERE id = $2', [grace_period_minutes, req.tenantId]);
    res.json({ message: 'Settings updated.', grace_period_minutes });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// Mark absent for staff who didn't check in
const markStaffAttendance = async (req, res) => {
  try {
    const { date, records } = req.body;
    if (!date || !records) return res.status(400).json({ error: 'Date and records required.' });

    for (const record of records) {
      await query(
        `INSERT INTO staff_attendance (tenant_id, staff_id, date, status)
         VALUES ($1,$2,$3,$4) ON CONFLICT (staff_id, date) DO UPDATE SET status = $4`,
        [req.tenantId, record.staff_id, date, record.status]
      );
    }
    res.json({ message: `Attendance marked for ${records.length} members.` });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = {
  getStaff, getStaffDetail, createStaff, updateStaff,
  checkIn, checkOut, overrideStatus, getTimeLogs,
  addIncentive, deleteIncentive, getTrainers, updateSettings, markStaffAttendance
};
