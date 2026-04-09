const { query } = require('../config/db');

// GET /api/students
const getStudents = async (req, res) => {
  try {
    const { course_id, batch_id, status, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE s.tenant_id = $1';
    const params = [req.tenantId];
    let paramIndex = 2;

    if (course_id) { whereClause += ` AND s.course_id = $${paramIndex++}`; params.push(course_id); }
    if (batch_id) { whereClause += ` AND s.batch_id = $${paramIndex++}`; params.push(batch_id); }
    if (status) { whereClause += ` AND s.status = $${paramIndex++}`; params.push(status); }
    if (search) {
      whereClause += ` AND (s.name ILIKE $${paramIndex} OR s.phone ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countResult = await query(`SELECT COUNT(*) FROM students s ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    const result = await query(
      `SELECT s.*, c.name as course_name, b.name as batch_name,
              (SELECT COALESCE(SUM(amount_paid), 0) FROM student_fees sf WHERE sf.student_id = s.id) as total_paid,
              (SELECT COALESCE(SUM(balance), 0) FROM student_fees sf WHERE sf.student_id = s.id) as total_balance
       FROM students s
       LEFT JOIN courses c ON s.course_id = c.id
       LEFT JOIN batches b ON s.batch_id = b.id
       ${whereClause}
       ORDER BY s.enrollment_date DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    res.json({
      students: result.rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ error: 'Failed to fetch students.' });
  }
};

// GET /api/students/:id
const getStudent = async (req, res) => {
  try {
    const result = await query(
      `SELECT s.*, c.name as course_name, c.fee_amount as course_fee,
              b.name as batch_name, b.start_date as batch_start, b.end_date as batch_end
       FROM students s
       LEFT JOIN courses c ON s.course_id = c.id
       LEFT JOIN batches b ON s.batch_id = b.id
       WHERE s.id = $1 AND s.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found.' });
    }

    // Fee details
    const fees = await query(
      `SELECT * FROM student_fees WHERE student_id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenantId]
    );

    // Payment history
    const payments = await query(
      `SELECT p.*, u.name as received_by_name
       FROM payments p
       LEFT JOIN users u ON p.received_by = u.id
       WHERE p.student_id = $1 AND p.tenant_id = $2
       ORDER BY p.payment_date DESC`,
      [req.params.id, req.tenantId]
    );

    // Attendance summary
    const attendance = await query(
      `SELECT status, COUNT(*) as count
       FROM attendance
       WHERE student_id = $1 AND tenant_id = $2
       GROUP BY status`,
      [req.params.id, req.tenantId]
    );

    res.json({
      student: result.rows[0],
      fees: fees.rows,
      payments: payments.rows,
      attendanceSummary: attendance.rows,
    });
  } catch (error) {
    console.error('Get student error:', error);
    res.status(500).json({ error: 'Failed to fetch student.' });
  }
};

// POST /api/students - Create student (manual or from lead enrollment)
const createStudent = async (req, res) => {
  try {
    const {
      lead_id, name, phone, email, address, course_id, batch_id,
      enrollment_date, total_fee, discount, payment_type, total_installments,
      installment_details // [{ amount, due_date }, ...] — optional custom dates/amounts
    } = req.body;

    if (!name || !phone || !course_id) {
      return res.status(400).json({ error: 'Name, phone, and course are required.' });
    }

    // Calculate expected completion from course duration
    const course = await query('SELECT * FROM courses WHERE id = $1 AND tenant_id = $2', [course_id, req.tenantId]);
    if (course.rows.length === 0) {
      return res.status(400).json({ error: 'Course not found.' });
    }

    const courseData = course.rows[0];
    let expectedCompletion = null;
    if (courseData.duration_value) {
      const enrollDate = new Date(enrollment_date || new Date());
      if (courseData.duration_unit === 'months') {
        expectedCompletion = new Date(enrollDate.setMonth(enrollDate.getMonth() + courseData.duration_value));
      } else {
        expectedCompletion = new Date(enrollDate.setDate(enrollDate.getDate() + courseData.duration_value));
      }
    }

    // Create student
    const result = await query(
      `INSERT INTO students (tenant_id, lead_id, name, phone, email, address, course_id, batch_id, enrollment_date, expected_completion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        req.tenantId, lead_id || null, name, phone, email || null, address || null,
        course_id, batch_id || null, enrollment_date || new Date(), expectedCompletion
      ]
    );

    const student = result.rows[0];

    // Create fee record if fee info provided
    const feeAmount = total_fee || courseData.fee_amount;
    const discountAmt = discount || 0;
    const netFee = feeAmount - discountAmt;
    const payType = payment_type || 'full';
    const installments = payType === 'installment' ? (total_installments || 2) : 1;

    const feeResult = await query(
      `INSERT INTO student_fees (tenant_id, student_id, total_fee, discount, net_fee, payment_type, total_installments, balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.tenantId, student.id, feeAmount, discountAmt, netFee, payType, installments, netFee]
    );

    // Create installment schedule if installment payment
    if (payType === 'installment' && installments > 1) {
      if (installment_details && Array.isArray(installment_details) && installment_details.length > 0) {
        // Custom installment dates/amounts from user
        for (let i = 0; i < installment_details.length; i++) {
          await query(
            `INSERT INTO fee_installments (tenant_id, student_fee_id, installment_number, amount, due_date)
             VALUES ($1, $2, $3, $4, $5)`,
            [req.tenantId, feeResult.rows[0].id, i + 1, parseFloat(installment_details[i].amount), installment_details[i].due_date]
          );
        }
      } else {
        // Auto-generate monthly installments
        const installmentAmount = Math.ceil(netFee / installments);
        const enrollDate = new Date(enrollment_date || new Date());

        for (let i = 1; i <= installments; i++) {
          const dueDate = new Date(enrollDate);
          dueDate.setMonth(dueDate.getMonth() + (i - 1));
          const amount = i === installments ? netFee - (installmentAmount * (installments - 1)) : installmentAmount;

          await query(
            `INSERT INTO fee_installments (tenant_id, student_fee_id, installment_number, amount, due_date)
             VALUES ($1, $2, $3, $4, $5)`,
            [req.tenantId, feeResult.rows[0].id, i, amount, dueDate]
          );
        }
      }
    }

    // If from lead, update lead stage to enrolled
    if (lead_id) {
      await query(
        "UPDATE leads SET stage = 'enrolled' WHERE id = $1 AND tenant_id = $2",
        [lead_id, req.tenantId]
      );
      // Log activity
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, old_value, new_value, created_by)
         VALUES ($1, $2, 'stage_change', 'Enrolled as Student', $3, 'interested', 'enrolled', $4)`,
        [req.tenantId, lead_id, `Enrolled in ${courseData.name}. Student created.`, req.user.id]
      );
    }

    res.status(201).json({ student, fee: feeResult.rows[0] });
  } catch (error) {
    console.error('Create student error:', error);
    res.status(500).json({ error: 'Failed to create student.' });
  }
};

// PUT /api/students/:id
const updateStudent = async (req, res) => {
  try {
    const { name, phone, email, address, status, certificate_status, certificate_issued_date } = req.body;
    const course_id = req.body.course_id || null;
    const batch_id = req.body.batch_id || null;

    const result = await query(
      `UPDATE students SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        email = COALESCE($3, email),
        address = COALESCE($4, address),
        course_id = COALESCE($5, course_id),
        batch_id = COALESCE($6, batch_id),
        status = COALESCE($7, status),
        certificate_status = COALESCE($8, certificate_status),
        certificate_issued_date = COALESCE($9, certificate_issued_date)
       WHERE id = $10 AND tenant_id = $11
       RETURNING *`,
      [name, phone, email, address, course_id, batch_id, status, certificate_status, certificate_issued_date || null, req.params.id, req.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found.' });
    }

    res.json({ student: result.rows[0] });
  } catch (error) {
    console.error('Update student error:', error);
    res.status(500).json({ error: 'Failed to update student.' });
  }
};

// POST /api/students/enroll-lead/:leadId - Enroll a lead as student
const enrollLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { course_id, batch_id, total_fee, discount, payment_type, total_installments } = req.body;

    // Get lead info
    const leadResult = await query(
      'SELECT * FROM leads WHERE id = $1 AND tenant_id = $2',
      [leadId, req.tenantId]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found.' });
    }

    const lead = leadResult.rows[0];

    // Check if already enrolled
    const existing = await query(
      'SELECT id FROM students WHERE lead_id = $1 AND tenant_id = $2',
      [leadId, req.tenantId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This lead is already enrolled as a student.' });
    }

    // Create student using the createStudent logic
    req.body = {
      lead_id: leadId,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      location: lead.location,
      course_id: course_id || lead.course_interest_id,
      batch_id,
      total_fee,
      discount,
      payment_type,
      total_installments,
      enrollment_date: new Date(),
    };

    return createStudent(req, res);
  } catch (error) {
    console.error('Enroll lead error:', error);
    res.status(500).json({ error: 'Failed to enroll lead.' });
  }
};

module.exports = { getStudents, getStudent, createStudent, updateStudent, enrollLead };
