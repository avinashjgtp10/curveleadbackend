const { query } = require('../config/db');
const { generateReceiptPDF } = require('../utils/pdfReceipt');
const { sendReceiptEmail } = require('../utils/email');

// GET /api/fees
const getAllFees = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = 'WHERE sf.tenant_id = $1';
    const params = [req.tenantId];
    let pi = 2;
    if (status) { whereClause += ` AND sf.status = $${pi++}`; params.push(status); }
    if (search) { whereClause += ` AND (s.name ILIKE $${pi} OR s.phone ILIKE $${pi})`; params.push(`%${search}%`); pi++; }

    const countResult = await query(`SELECT COUNT(*) FROM student_fees sf JOIN students s ON sf.student_id = s.id ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    const result = await query(
      `SELECT sf.*, s.name as student_name, s.phone as student_phone, c.name as course_name
       FROM student_fees sf JOIN students s ON sf.student_id = s.id LEFT JOIN courses c ON s.course_id = c.id
       ${whereClause} ORDER BY sf.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`,
      [...params, limit, offset]
    );

    const summary = await query(
      `SELECT COALESCE(SUM(net_fee),0) as total_booked, COALESCE(SUM(amount_paid),0) as total_collected,
              COALESCE(SUM(balance),0) as total_pending, COUNT(*) as total_students,
              COUNT(CASE WHEN status='paid' THEN 1 END) as fully_paid,
              COUNT(CASE WHEN status IN ('pending','partial','overdue') THEN 1 END) as with_balance
       FROM student_fees WHERE tenant_id = $1`, [req.tenantId]
    );

    res.json({ fees: result.rows, summary: summary.rows[0], pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) } });
  } catch (error) { console.error('Get fees error:', error); res.status(500).json({ error: 'Failed to fetch fees.' }); }
};

// GET /api/fees/:id
const getFeeDetails = async (req, res) => {
  try {
    const fee = await query(
      `SELECT sf.*, s.name as student_name, s.phone as student_phone, c.name as course_name
       FROM student_fees sf JOIN students s ON sf.student_id = s.id LEFT JOIN courses c ON s.course_id = c.id
       WHERE sf.id = $1 AND sf.tenant_id = $2`, [req.params.id, req.tenantId]
    );
    if (fee.rows.length === 0) return res.status(404).json({ error: 'Fee record not found.' });

    const installments = await query('SELECT * FROM fee_installments WHERE student_fee_id = $1 AND tenant_id = $2 ORDER BY installment_number', [req.params.id, req.tenantId]);
    const payments = await query(
      `SELECT p.*, u.name as received_by_name FROM payments p LEFT JOIN users u ON p.received_by = u.id
       WHERE p.student_fee_id = $1 AND p.tenant_id = $2 ORDER BY p.payment_date DESC`, [req.params.id, req.tenantId]
    );
    res.json({ fee: fee.rows[0], installments: installments.rows, payments: payments.rows });
  } catch (error) { console.error('Get fee details error:', error); res.status(500).json({ error: 'Failed to fetch fee details.' }); }
};

// POST /api/fees/:id/pay
const recordPayment = async (req, res) => {
  try {
    const { amount, payment_date, payment_mode, installment_id, notes } = req.body;
    if (!amount || !payment_date || !payment_mode) return res.status(400).json({ error: 'Amount, payment date, and payment mode are required.' });

    const feeResult = await query('SELECT * FROM student_fees WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (feeResult.rows.length === 0) return res.status(404).json({ error: 'Fee record not found.' });
    const fee = feeResult.rows[0];

    const receiptCount = await query('SELECT COUNT(*) FROM payments WHERE tenant_id = $1', [req.tenantId]);
    const receiptNumber = `RCP-${String(parseInt(receiptCount.rows[0].count) + 1).padStart(4, '0')}`;

    const payment = await query(
      `INSERT INTO payments (tenant_id, student_id, student_fee_id, installment_id, amount, payment_date, payment_mode, receipt_number, notes, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.tenantId, fee.student_id, req.params.id, installment_id || null, parseFloat(amount), payment_date, payment_mode, receiptNumber, notes, req.user.id]
    );

    const newPaid = parseFloat(fee.amount_paid) + parseFloat(amount);
    const newBalance = parseFloat(fee.net_fee) - newPaid;
    const newStatus = newBalance <= 0 ? 'paid' : 'partial';
    await query('UPDATE student_fees SET amount_paid=$1, balance=$2, status=$3 WHERE id=$4', [newPaid, Math.max(newBalance, 0), newStatus, req.params.id]);

    if (installment_id) {
      await query("UPDATE fee_installments SET status='paid', paid_date=$1 WHERE id=$2", [payment_date, installment_id]);
    }

    res.status(201).json({ payment: payment.rows[0], receiptNumber });
  } catch (error) { console.error('Record payment error:', error); res.status(500).json({ error: 'Failed to record payment.' }); }
};

// PUT /api/fees/:id/installments
const updateInstallments = async (req, res) => {
  try {
    const { installments } = req.body;
    if (!installments || !Array.isArray(installments)) return res.status(400).json({ error: 'Installments data is required.' });

    for (const inst of installments) {
      await query('UPDATE fee_installments SET amount=$1, due_date=$2 WHERE id=$3 AND tenant_id=$4', [inst.amount, inst.due_date, inst.id, req.tenantId]);
    }
    res.json({ message: 'Installments updated successfully.' });
  } catch (error) { console.error('Update installments error:', error); res.status(500).json({ error: 'Failed to update installments.' }); }
};

// GET /api/fees/revenue/monthly
const getMonthlyRevenue = async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;

    const booked = await query(
      `SELECT TO_CHAR(s.enrollment_date, 'YYYY-MM') as month, COALESCE(SUM(sf.net_fee),0) as booked, COUNT(DISTINCT s.id) as new_students
       FROM student_fees sf JOIN students s ON sf.student_id = s.id
       WHERE sf.tenant_id = $1 AND s.enrollment_date >= CURRENT_DATE - INTERVAL '${months} months'
       GROUP BY TO_CHAR(s.enrollment_date, 'YYYY-MM') ORDER BY month`, [req.tenantId]
    );

    const collected = await query(
      `SELECT TO_CHAR(payment_date, 'YYYY-MM') as month, COALESCE(SUM(amount),0) as collected
       FROM payments WHERE tenant_id = $1 AND payment_date >= CURRENT_DATE - INTERVAL '${months} months'
       GROUP BY TO_CHAR(payment_date, 'YYYY-MM') ORDER BY month`, [req.tenantId]
    );

    const byMode = await query(
      `SELECT payment_mode, COALESCE(SUM(amount),0) as total FROM payments
       WHERE tenant_id = $1 AND payment_date >= CURRENT_DATE - INTERVAL '${months} months'
       GROUP BY payment_mode`, [req.tenantId]
    );

    const monthMap = {};
    booked.rows.forEach(r => { monthMap[r.month] = { month: r.month, booked: parseFloat(r.booked), collected: 0, new_students: parseInt(r.new_students) }; });
    collected.rows.forEach(r => { if (!monthMap[r.month]) monthMap[r.month] = { month: r.month, booked: 0, collected: 0, new_students: 0 }; monthMap[r.month].collected = parseFloat(r.collected); });

    const monthly = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ ...m, pending: m.booked - m.collected }));
    const totals = { booked: monthly.reduce((s, m) => s + m.booked, 0), collected: monthly.reduce((s, m) => s + m.collected, 0), pending: monthly.reduce((s, m) => s + m.pending, 0), students: monthly.reduce((s, m) => s + m.new_students, 0) };

    res.json({ monthly, totals, byPaymentMode: byMode.rows });
  } catch (error) { console.error('Monthly revenue error:', error); res.status(500).json({ error: 'Failed to fetch revenue data.' }); }
};

// GET /api/fees/reminders
const getReminders = async (req, res) => {
  try {
    const result = await query(
      `SELECT fi.id as installment_id, fi.installment_number, fi.amount, fi.due_date, fi.status,
              sf.id as fee_id, sf.net_fee, sf.amount_paid, sf.balance,
              s.id as student_id, s.name as student_name, s.phone as student_phone, c.name as course_name,
              CASE WHEN fi.due_date < CURRENT_DATE THEN 'overdue' WHEN fi.due_date = CURRENT_DATE THEN 'due_today'
                WHEN fi.due_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'upcoming' ELSE 'future' END as urgency,
              (CURRENT_DATE - fi.due_date) as days_overdue
       FROM fee_installments fi JOIN student_fees sf ON fi.student_fee_id = sf.id
       JOIN students s ON sf.student_id = s.id LEFT JOIN courses c ON s.course_id = c.id
       WHERE fi.tenant_id = $1 AND fi.status = 'pending' AND fi.due_date <= CURRENT_DATE + INTERVAL '30 days'
       ORDER BY fi.due_date ASC`, [req.tenantId]
    );

    res.json({
      reminders: result.rows,
      summary: { overdue: result.rows.filter(r => r.urgency === 'overdue').length, dueToday: result.rows.filter(r => r.urgency === 'due_today').length, upcoming: result.rows.filter(r => r.urgency === 'upcoming').length },
    });
  } catch (error) { console.error('Get reminders error:', error); res.status(500).json({ error: 'Failed to fetch reminders.' }); }
};

// POST /api/fees/reminders/:installmentId/action
const actionReminder = async (req, res) => {
  try {
    const { action, notes, promised_date } = req.body;
    const inst = await query(
      'SELECT fi.*, sf.student_id FROM fee_installments fi JOIN student_fees sf ON fi.student_fee_id = sf.id WHERE fi.id = $1 AND fi.tenant_id = $2',
      [req.params.installmentId, req.tenantId]
    );
    if (inst.rows.length === 0) return res.status(404).json({ error: 'Installment not found.' });

    await query(
      `INSERT INTO fee_reminders (tenant_id, student_id, student_fee_id, installment_id, reminder_type, status, promised_date, actioned_by, actioned_at, notes)
       VALUES ($1,$2,$3,$4,'manual',$5,$6,$7,CURRENT_TIMESTAMP,$8)`,
      [req.tenantId, inst.rows[0].student_id, inst.rows[0].student_fee_id, req.params.installmentId, action, promised_date || null, req.user.id, notes]
    );
    res.json({ message: 'Reminder actioned.' });
  } catch (error) { console.error('Action reminder error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/fees/:id/receipt/:paymentId
const getReceiptData = async (req, res) => {
  try {
    const payment = await query(
      `SELECT p.*, s.name as student_name, s.phone as student_phone, s.email as student_email,
              c.name as course_name, sf.total_fee, sf.discount, sf.net_fee, sf.amount_paid, sf.balance,
              t.name as academy_name, t.email as academy_email, t.phone as academy_phone, t.address as academy_address, t.logo_url,
              u.name as received_by_name
       FROM payments p JOIN students s ON p.student_id = s.id LEFT JOIN courses c ON s.course_id = c.id
       JOIN student_fees sf ON p.student_fee_id = sf.id JOIN tenants t ON p.tenant_id = t.id LEFT JOIN users u ON p.received_by = u.id
       WHERE p.id = $1 AND p.tenant_id = $2`, [req.params.paymentId, req.tenantId]
    );
    if (payment.rows.length === 0) return res.status(404).json({ error: 'Payment not found.' });
    res.json({ receipt: payment.rows[0] });
  } catch (error) { console.error('Get receipt error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/fees/:id - Delete fee record (and its payments/installments)
const deleteFee = async (req, res) => {
  try {
    const fee = await query('SELECT id FROM student_fees WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (fee.rows.length === 0) return res.status(404).json({ error: 'Fee not found.' });

    await query('DELETE FROM payments WHERE student_fee_id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    await query('DELETE FROM fee_installments WHERE student_fee_id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    await query('DELETE FROM student_fees WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);

    res.json({ message: 'Fee record deleted.' });
  } catch (error) { console.error('Delete fee error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/fees/payment/:id - Delete a single payment
const deletePayment = async (req, res) => {
  try {
    const payment = await query('SELECT * FROM payments WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (payment.rows.length === 0) return res.status(404).json({ error: 'Payment not found.' });

    const p = payment.rows[0];

    // Reverse the payment amounts
    await query(
      `UPDATE student_fees SET amount_paid = amount_paid - $1, balance = balance + $1,
       status = CASE WHEN amount_paid - $1 <= 0 THEN 'pending' ELSE 'partial' END
       WHERE id = $2 AND tenant_id = $3`,
      [p.amount, p.student_fee_id, req.tenantId]
    );

    // If payment was for an installment, mark it unpaid
    if (p.installment_id) {
      await query(
        "UPDATE fee_installments SET status = 'pending', paid_amount = 0, paid_date = NULL WHERE id = $1",
        [p.installment_id]
      );
    }

    await query('DELETE FROM payments WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);

    res.json({ message: 'Payment deleted and balance restored.' });
  } catch (error) { console.error('Delete payment error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// GET /api/fees/:id/receipt/:paymentId/pdf - Download PDF receipt
const downloadReceiptPDF = async (req, res) => {
  try {
    const payment = await query(
      `SELECT p.*, s.name as student_name, s.phone as student_phone, s.email as student_email,
              c.name as course_name, sf.total_fee, sf.discount, sf.net_fee, sf.amount_paid, sf.balance,
              t.name as academy_name, t.email as academy_email, t.phone as academy_phone, t.address as academy_address, t.logo_url,
              u.name as received_by_name
       FROM payments p JOIN students s ON p.student_id = s.id LEFT JOIN courses c ON s.course_id = c.id
       JOIN student_fees sf ON p.student_fee_id = sf.id JOIN tenants t ON p.tenant_id = t.id LEFT JOIN users u ON p.received_by = u.id
       WHERE p.id = $1 AND p.tenant_id = $2`, [req.params.paymentId, req.tenantId]
    );
    if (payment.rows.length === 0) return res.status(404).json({ error: 'Payment not found.' });

    const pdfBuffer = await generateReceiptPDF(payment.rows[0]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=Receipt_${payment.rows[0].receipt_number}.pdf`);
    res.send(pdfBuffer);
  } catch (error) { console.error('PDF receipt error:', error); res.status(500).json({ error: 'Failed to generate PDF.' }); }
};

// POST /api/fees/:id/receipt/:paymentId/email - Email receipt to student
const emailReceipt = async (req, res) => {
  try {
    const payment = await query(
      `SELECT p.*, s.name as student_name, s.phone as student_phone, s.email as student_email,
              c.name as course_name, sf.total_fee, sf.discount, sf.net_fee, sf.amount_paid, sf.balance,
              t.name as academy_name, t.email as academy_email, t.phone as academy_phone, t.address as academy_address,
              u.name as received_by_name
       FROM payments p JOIN students s ON p.student_id = s.id LEFT JOIN courses c ON s.course_id = c.id
       JOIN student_fees sf ON p.student_fee_id = sf.id JOIN tenants t ON p.tenant_id = t.id LEFT JOIN users u ON p.received_by = u.id
       WHERE p.id = $1 AND p.tenant_id = $2`, [req.params.paymentId, req.tenantId]
    );
    if (payment.rows.length === 0) return res.status(404).json({ error: 'Payment not found.' });

    const d = payment.rows[0];
    const emailTo = req.body.email || d.student_email;
    if (!emailTo) return res.status(400).json({ error: 'No email address available for this student.' });

    const pdfBuffer = await generateReceiptPDF(d);
    const result = await sendReceiptEmail(emailTo, d.student_name, d, pdfBuffer, d.academy_name);

    if (result.success) {
      res.json({ message: `Receipt emailed to ${emailTo}`, dev: result.dev || false });
    } else {
      res.status(500).json({ error: result.error || 'Failed to send email.' });
    }
  } catch (error) { console.error('Email receipt error:', error); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getAllFees, getFeeDetails, recordPayment, updateInstallments, getMonthlyRevenue, getReminders, actionReminder, getReceiptData, deleteFee, deletePayment, downloadReceiptPDF, emailReceipt };
