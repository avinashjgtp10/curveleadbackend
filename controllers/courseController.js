const { query } = require('../config/db');

// GET /api/courses
const getCourses = async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM courses WHERE tenant_id = $1 AND is_active = true ORDER BY name`,
      [req.tenantId]
    );
    res.json({ courses: result.rows });
  } catch (error) {
    console.error('Get courses error:', error);
    res.status(500).json({ error: 'Failed to fetch courses.' });
  }
};

// POST /api/courses
const createCourse = async (req, res) => {
  try {
    const { name, description, duration_value, duration_unit, fee_amount } = req.body;

    if (!name || !fee_amount) {
      return res.status(400).json({ error: 'Course name and fee amount are required.' });
    }

    const result = await query(
      `INSERT INTO courses (tenant_id, name, description, duration_value, duration_unit, fee_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.tenantId, name, description, duration_value, duration_unit || 'months', fee_amount]
    );

    res.status(201).json({ course: result.rows[0] });
  } catch (error) {
    console.error('Create course error:', error);
    res.status(500).json({ error: 'Failed to create course.' });
  }
};

// PUT /api/courses/:id
const updateCourse = async (req, res) => {
  try {
    const { name, description, duration_value, duration_unit, fee_amount, is_active } = req.body;

    const result = await query(
      `UPDATE courses SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        duration_value = COALESCE($3, duration_value),
        duration_unit = COALESCE($4, duration_unit),
        fee_amount = COALESCE($5, fee_amount),
        is_active = COALESCE($6, is_active)
       WHERE id = $7 AND tenant_id = $8
       RETURNING *`,
      [name, description, duration_value, duration_unit, fee_amount, is_active, req.params.id, req.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Course not found.' });
    }

    res.json({ course: result.rows[0] });
  } catch (error) {
    console.error('Update course error:', error);
    res.status(500).json({ error: 'Failed to update course.' });
  }
};

// DELETE /api/courses/:id
const deleteCourse = async (req, res) => {
  try {
    await query(
      'UPDATE courses SET is_active = false WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    res.json({ message: 'Course deactivated successfully.' });
  } catch (error) {
    console.error('Delete course error:', error);
    res.status(500).json({ error: 'Failed to delete course.' });
  }
};

module.exports = { getCourses, createCourse, updateCourse, deleteCourse };
