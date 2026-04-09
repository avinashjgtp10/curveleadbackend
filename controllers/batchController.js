const { query } = require('../config/db');

// GET /api/batches
const getBatches = async (req, res) => {
  try {
    const { course_id, active_only } = req.query;
    let whereClause = 'WHERE b.tenant_id = $1';
    const params = [req.tenantId];
    let paramIndex = 2;

    if (course_id) {
      whereClause += ` AND b.course_id = $${paramIndex++}`;
      params.push(course_id);
    }
    if (active_only === 'true') {
      whereClause += ' AND b.is_active = true';
    }

    const result = await query(
      `SELECT b.*, c.name as course_name,
              (SELECT COUNT(*) FROM students s WHERE s.batch_id = b.id AND s.status = 'active') as student_count
       FROM batches b
       LEFT JOIN courses c ON b.course_id = c.id
       ${whereClause}
       ORDER BY b.start_date DESC`,
      params
    );

    res.json({ batches: result.rows });
  } catch (error) {
    console.error('Get batches error:', error);
    res.status(500).json({ error: 'Failed to fetch batches.' });
  }
};

// GET /api/batches/:id
const getBatch = async (req, res) => {
  try {
    const result = await query(
      `SELECT b.*, c.name as course_name
       FROM batches b
       LEFT JOIN courses c ON b.course_id = c.id
       WHERE b.id = $1 AND b.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    // Get students in this batch
    const students = await query(
      `SELECT s.id, s.name, s.phone, s.enrollment_date, s.status, s.certificate_status
       FROM students s
       WHERE s.batch_id = $1 AND s.tenant_id = $2
       ORDER BY s.name`,
      [req.params.id, req.tenantId]
    );

    res.json({ batch: result.rows[0], students: students.rows });
  } catch (error) {
    console.error('Get batch error:', error);
    res.status(500).json({ error: 'Failed to fetch batch.' });
  }
};

// POST /api/batches
const createBatch = async (req, res) => {
  try {
    const { course_id, name, trainer_name, start_date, end_date, capacity } = req.body;

    if (!name || !course_id) {
      return res.status(400).json({ error: 'Batch name and course are required.' });
    }

    const result = await query(
      `INSERT INTO batches (tenant_id, course_id, name, trainer_name, start_date, end_date, capacity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.tenantId, course_id, name, trainer_name, start_date || null, end_date || null, capacity || 20]
    );

    res.status(201).json({ batch: result.rows[0] });
  } catch (error) {
    console.error('Create batch error:', error);
    res.status(500).json({ error: 'Failed to create batch.' });
  }
};

// PUT /api/batches/:id
const updateBatch = async (req, res) => {
  try {
    const { name, trainer_name, start_date, end_date, capacity, is_active } = req.body;
    const course_id = req.body.course_id || null;

    const result = await query(
      `UPDATE batches SET
        name = COALESCE($1, name),
        course_id = COALESCE($2, course_id),
        trainer_name = COALESCE($3, trainer_name),
        start_date = COALESCE($4, start_date),
        end_date = COALESCE($5, end_date),
        capacity = COALESCE($6, capacity),
        is_active = COALESCE($7, is_active)
       WHERE id = $8 AND tenant_id = $9
       RETURNING *`,
      [name, course_id, trainer_name, start_date, end_date, capacity, is_active, req.params.id, req.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    res.json({ batch: result.rows[0] });
  } catch (error) {
    console.error('Update batch error:', error);
    res.status(500).json({ error: 'Failed to update batch.' });
  }
};

// DELETE /api/batches/:id
const deleteBatch = async (req, res) => {
  try {
    await query(
      'UPDATE batches SET is_active = false WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    res.json({ message: 'Batch deactivated successfully.' });
  } catch (error) {
    console.error('Delete batch error:', error);
    res.status(500).json({ error: 'Failed to delete batch.' });
  }
};

module.exports = { getBatches, getBatch, createBatch, updateBatch, deleteBatch };
