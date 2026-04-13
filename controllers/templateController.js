const { query } = require('../config/db');

// GET /api/templates
const getTemplates = async (req, res) => {
  try {
    const { category } = req.query;
    let whereClause = 'WHERE tenant_id = $1 AND is_active = true';
    const params = [req.tenantId];

    if (category) {
      whereClause += ' AND category = $2';
      params.push(category);
    }

    const result = await query(
      `SELECT * FROM message_templates ${whereClause} ORDER BY category, name`, params
    );
    res.json({ templates: result.rows });
  } catch (error) { console.error('Get templates error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/templates
const createTemplate = async (req, res) => {
  try {
    const { name, category, channel, message } = req.body;
    if (!name || !message) return res.status(400).json({ error: 'Name and message are required.' });

    const result = await query(
      `INSERT INTO message_templates (tenant_id, name, category, channel, message, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.tenantId, name, category || 'custom', channel || 'whatsapp', message, req.user.id]
    );
    res.status(201).json({ template: result.rows[0] });
  } catch (error) { console.error('Create template error:', error); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/templates/:id
const updateTemplate = async (req, res) => {
  try {
    const { name, category, channel, message, is_active } = req.body;
    const result = await query(
      `UPDATE message_templates SET name=COALESCE($1,name), category=COALESCE($2,category),
       channel=COALESCE($3,channel), message=COALESCE($4,message), is_active=COALESCE($5,is_active)
       WHERE id=$6 AND tenant_id=$7 RETURNING *`,
      [name, category, channel, message, is_active, req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });
    res.json({ template: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/templates/:id
const deleteTemplate = async (req, res) => {
  try {
    await query('DELETE FROM message_templates WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    res.json({ message: 'Template deleted.' });
  } catch (error) { res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/templates/:id/send - Generate personalized message for a lead
const generateMessage = async (req, res) => {
  try {
    const { lead_id, student_id, installment_id } = req.body;

    // Get template
    const template = await query('SELECT * FROM message_templates WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (template.rows.length === 0) return res.status(404).json({ error: 'Template not found.' });

    // Get tenant info
    const tenant = await query('SELECT name, email, phone, address FROM tenants WHERE id = $1', [req.tenantId]);
    const academy = tenant.rows[0];

    let variables = {
      academy: academy.name || '',
      academy_phone: academy.phone || '',
      academy_email: academy.email || '',
      academy_address: academy.address || '',
    };

    // Get lead info if provided
    if (lead_id) {
      const lead = await query(
        `SELECT l.*, c.name as course_name, c.fee_amount as course_fee, c.duration_value, c.duration_unit
         FROM leads l LEFT JOIN courses c ON l.course_interest_id = c.id
         WHERE l.id = $1 AND l.tenant_id = $2`, [lead_id, req.tenantId]
      );
      if (lead.rows.length > 0) {
        const l = lead.rows[0];
        variables = {
          ...variables,
          name: l.name || '',
          phone: l.phone || '',
          email: l.email || '',
          location: l.location || '',
          course: l.course_name || '',
          course_fee: l.course_fee ? parseFloat(l.course_fee).toLocaleString('en-IN') : '',
          course_duration: l.duration_value ? `${l.duration_value} ${l.duration_unit}` : '',
        };
      }
    }

    // Get student info if provided
    if (student_id) {
      const student = await query(
        `SELECT s.*, c.name as course_name, c.fee_amount as course_fee,
                sf.balance, sf.net_fee, sf.amount_paid
         FROM students s LEFT JOIN courses c ON s.course_id = c.id
         LEFT JOIN student_fees sf ON sf.student_id = s.id
         WHERE s.id = $1 AND s.tenant_id = $2`, [student_id, req.tenantId]
      );
      if (student.rows.length > 0) {
        const s = student.rows[0];
        variables = {
          ...variables,
          name: s.name || '',
          phone: s.phone || '',
          course: s.course_name || '',
          balance: s.balance ? parseFloat(s.balance).toLocaleString('en-IN') : '',
          total_fee: s.net_fee ? parseFloat(s.net_fee).toLocaleString('en-IN') : '',
          paid: s.amount_paid ? parseFloat(s.amount_paid).toLocaleString('en-IN') : '',
        };
      }
    }

    // Get installment info if provided
    if (installment_id) {
      const inst = await query(
        'SELECT amount, due_date FROM fee_installments WHERE id = $1 AND tenant_id = $2',
        [installment_id, req.tenantId]
      );
      if (inst.rows.length > 0) {
        variables.amount = parseFloat(inst.rows[0].amount).toLocaleString('en-IN');
        variables.due_date = new Date(inst.rows[0].due_date).toLocaleDateString('en-IN');
      }
    }

    // Replace variables in template
    let personalizedMessage = template.rows[0].message;
    for (const [key, value] of Object.entries(variables)) {
      personalizedMessage = personalizedMessage.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }

    // Increment use count
    await query('UPDATE message_templates SET use_count = use_count + 1 WHERE id = $1', [req.params.id]);

    // Generate WhatsApp URL
    const phone = variables.phone?.replace(/\D/g, '').slice(-10);
    const whatsappUrl = phone ? `https://wa.me/91${phone}?text=${encodeURIComponent(personalizedMessage)}` : null;

    res.json({
      message: personalizedMessage,
      whatsappUrl,
      variables,
    });
  } catch (error) { console.error('Generate message error:', error); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getTemplates, createTemplate, updateTemplate, deleteTemplate, generateMessage };
