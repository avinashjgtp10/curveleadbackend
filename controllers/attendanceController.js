const { query } = require('../config/db');

// GET /api/attendance/:batchId?date=YYYY-MM-DD
const getAttendance = async (req, res) => {
  try {
    const { batchId } = req.params;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    // Get all students in batch
    const students = await query(
      `SELECT s.id, s.name, s.phone
       FROM students s
       WHERE s.batch_id = $1 AND s.tenant_id = $2 AND s.status = 'active'
       ORDER BY s.name`,
      [batchId, req.tenantId]
    );

    // Get existing attendance for this date
    const attendance = await query(
      `SELECT student_id, status FROM attendance
       WHERE batch_id = $1 AND tenant_id = $2 AND date = $3`,
      [batchId, req.tenantId, date]
    );

    const attendanceMap = {};
    attendance.rows.forEach(a => { attendanceMap[a.student_id] = a.status; });

    const result = students.rows.map(s => ({
      ...s,
      status: attendanceMap[s.id] || null, // null = not marked
    }));

    res.json({ date, batchId, students: result });
  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ error: 'Failed to fetch attendance.' });
  }
};

// POST /api/attendance/:batchId - Mark attendance for multiple students
const markAttendance = async (req, res) => {
  try {
    const { batchId } = req.params;
    const { date, records } = req.body;
    // records: [{ student_id: 'uuid', status: 'present|absent|late' }]

    if (!date || !records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'Date and attendance records are required.' });
    }

    let marked = 0;
    for (const record of records) {
      if (!record.student_id || !record.status) continue;

      await query(
        `INSERT INTO attendance (tenant_id, student_id, batch_id, date, status, marked_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (student_id, date)
         DO UPDATE SET status = $5, marked_by = $6`,
        [req.tenantId, record.student_id, batchId, date, record.status, req.user.id]
      );
      marked++;
    }

    res.json({ message: `Attendance marked for ${marked} students.`, date });
  } catch (error) {
    console.error('Mark attendance error:', error);
    res.status(500).json({ error: 'Failed to mark attendance.' });
  }
};

// GET /api/attendance/student/:studentId?month=YYYY-MM
const getStudentAttendance = async (req, res) => {
  try {
    const { studentId } = req.params;
    const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM

    const result = await query(
      `SELECT date, status FROM attendance
       WHERE student_id = $1 AND tenant_id = $2
       AND TO_CHAR(date, 'YYYY-MM') = $3
       ORDER BY date`,
      [studentId, req.tenantId, month]
    );

    // Summary
    const summary = { present: 0, absent: 0, late: 0 };
    result.rows.forEach(r => { if (summary[r.status] !== undefined) summary[r.status]++; });

    res.json({
      studentId,
      month,
      records: result.rows,
      summary,
      totalDays: result.rows.length,
    });
  } catch (error) {
    console.error('Student attendance error:', error);
    res.status(500).json({ error: 'Failed to fetch student attendance.' });
  }
};

// GET /api/attendance/report/:batchId?month=YYYY-MM
const getBatchAttendanceReport = async (req, res) => {
  try {
    const { batchId } = req.params;
    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const result = await query(
      `SELECT s.id as student_id, s.name, s.phone,
              COUNT(CASE WHEN a.status = 'present' THEN 1 END) as present_days,
              COUNT(CASE WHEN a.status = 'absent' THEN 1 END) as absent_days,
              COUNT(CASE WHEN a.status = 'late' THEN 1 END) as late_days,
              COUNT(a.id) as total_days
       FROM students s
       LEFT JOIN attendance a ON s.id = a.student_id
         AND a.tenant_id = $1
         AND TO_CHAR(a.date, 'YYYY-MM') = $3
       WHERE s.batch_id = $2 AND s.tenant_id = $1 AND s.status = 'active'
       GROUP BY s.id, s.name, s.phone
       ORDER BY s.name`,
      [req.tenantId, batchId, month]
    );

    res.json({ batchId, month, report: result.rows });
  } catch (error) {
    console.error('Batch attendance report error:', error);
    res.status(500).json({ error: 'Failed to fetch attendance report.' });
  }
};

module.exports = { getAttendance, markAttendance, getStudentAttendance, getBatchAttendanceReport };
