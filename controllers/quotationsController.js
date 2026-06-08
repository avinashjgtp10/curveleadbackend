const { query, transaction } = require('../config/db');

// GET /api/quotations
const getQuotations = async (req, res) => {
  try {
    const { lead_id, status } = req.query;
    let sql = `SELECT q.*, l.name as lead_name, l.phone as lead_phone, u.name as created_by_name
               FROM quotations q
               LEFT JOIN leads l ON q.lead_id = l.id
               LEFT JOIN users u ON q.created_by = u.id
               WHERE q.tenant_id = $1`;
    const params = [req.tenantId];
    let i = 2;

    if (lead_id) { sql += ` AND q.lead_id = $${i++}`; params.push(lead_id); }
    if (status) { sql += ` AND q.status = $${i++}`; params.push(status); }
    sql += ` ORDER BY q.created_at DESC`;

    const result = await query(sql, params);
    res.json({ quotations: result.rows });
  } catch (error) {
    console.error('Get quotations error:', error);
    res.status(500).json({ error: 'Failed to fetch quotations.' });
  }
};

// GET /api/quotations/:id
const getQuotation = async (req, res) => {
  try {
    const result = await query(
      `SELECT q.*, l.name as lead_name, l.phone as lead_phone, l.email as lead_email,
              t.name as business_name, t.phone as business_phone, t.address as business_address
       FROM quotations q
       LEFT JOIN leads l ON q.lead_id = l.id
       LEFT JOIN tenants t ON q.tenant_id = t.id
       WHERE q.id = $1 AND q.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Quotation not found.' });
    res.json({ quotation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quotation.' });
  }
};

// Calculate totals from items
const calculateTotals = (items, discountPercent = 0, taxPercent = 18) => {
  const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.quantity) * parseFloat(item.price)), 0);
  const discountAmount = (subtotal * discountPercent) / 100;
  const taxableAmount = subtotal - discountAmount;
  const taxAmount = (taxableAmount * taxPercent) / 100;
  const total = taxableAmount + taxAmount;
  return { subtotal, discountAmount, taxAmount, total };
};

// POST /api/quotations
const createQuotation = async (req, res) => {
  try {
    const { lead_id, title, items, discount_percent = 0, tax_percent = 18, valid_until, terms, notes } = req.body;

    if (!lead_id || !items || items.length === 0) {
      return res.status(400).json({ error: 'Lead and items required.' });
    }

    // Calculate item totals
    const itemsWithTotal = items.map(item => ({
      ...item,
      total: parseFloat(item.quantity) * parseFloat(item.price),
    }));

    const totals = calculateTotals(itemsWithTotal, discount_percent, tax_percent);

    // Generate quote number using transaction
    const quotation = await transaction(async (client) => {
      // Get/create counter
      await client.query(
        `INSERT INTO quotation_counter (tenant_id, last_number)
         VALUES ($1, 1)
         ON CONFLICT (tenant_id) DO UPDATE SET last_number = quotation_counter.last_number + 1
         RETURNING last_number, prefix`,
        [req.tenantId]
      );

      const counterResult = await client.query(
        `SELECT last_number, prefix FROM quotation_counter WHERE tenant_id = $1`,
        [req.tenantId]
      );
      const { last_number, prefix } = counterResult.rows[0];
      const quoteNumber = `${prefix}-${String(last_number).padStart(5, '0')}`;

      const result = await client.query(
        `INSERT INTO quotations
         (tenant_id, lead_id, quote_number, title, items, subtotal, discount_percent, discount_amount, tax_percent, tax_amount, total, valid_until, terms, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [req.tenantId, lead_id, quoteNumber, title, JSON.stringify(itemsWithTotal),
         totals.subtotal, discount_percent, totals.discountAmount, tax_percent, totals.taxAmount, totals.total,
         valid_until, terms, notes, req.user.id]
      );

      // Activity log
      await client.query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
         VALUES ($1, $2, 'quotation_created', $3, $4, $5)`,
        [req.tenantId, lead_id, `Quotation ${quoteNumber} created`, `Total: ₹${totals.total.toFixed(2)}`, req.user.id]
      );

      return result.rows[0];
    });

    res.status(201).json({ quotation });
  } catch (error) {
    console.error('Create quotation error:', error);
    res.status(500).json({ error: 'Failed to create quotation.' });
  }
};

// PUT /api/quotations/:id
const updateQuotation = async (req, res) => {
  try {
    const { title, items, discount_percent, tax_percent, valid_until, terms, notes } = req.body;

    const itemsWithTotal = items?.map(item => ({
      ...item,
      total: parseFloat(item.quantity) * parseFloat(item.price),
    }));

    const totals = itemsWithTotal ? calculateTotals(itemsWithTotal, discount_percent, tax_percent) : {};

    const result = await query(
      `UPDATE quotations SET
         title = $1, items = $2, subtotal = $3, discount_percent = $4, discount_amount = $5,
         tax_percent = $6, tax_amount = $7, total = $8, valid_until = $9, terms = $10, notes = $11, updated_at = NOW()
       WHERE id = $12 AND tenant_id = $13 AND status = 'draft'
       RETURNING *`,
      [title, JSON.stringify(itemsWithTotal), totals.subtotal, discount_percent, totals.discountAmount,
       tax_percent, totals.taxAmount, totals.total, valid_until, terms, notes,
       req.params.id, req.tenantId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Quotation not found or already sent.' });
    res.json({ quotation: result.rows[0] });
  } catch (error) {
    console.error('Update quotation error:', error);
    res.status(500).json({ error: 'Failed to update.' });
  }
};

// POST /api/quotations/:id/send
const sendQuotation = async (req, res) => {
  try {
    const result = await query(
      `UPDATE quotations SET status = 'sent', sent_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });

    const quote = result.rows[0];

    // Get lead phone
    const leadResult = await query('SELECT phone, name FROM leads WHERE id = $1', [quote.lead_id]);
    const lead = leadResult.rows[0];

    // WhatsApp click-to-chat link
    const viewUrl = `${process.env.FRONTEND_URL}/quotations/${quote.id}/view`;
    const message = `Hi ${lead.name},\n\nPlease find your quotation:\n\n*Quote #:* ${quote.quote_number}\n*Total:* ₹${parseFloat(quote.total).toLocaleString('en-IN')}\n*Valid Until:* ${new Date(quote.valid_until).toLocaleDateString('en-IN')}\n\nView details: ${viewUrl}\n\nLet me know if you'd like to discuss!`;
    const waLink = `https://wa.me/${lead.phone.replace(/[^\d]/g, '')}?text=${encodeURIComponent(message)}`;

    // Save as WhatsApp message
    await query(
      `INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message, message_type, sent_by)
       VALUES ($1, $2, 'outbound', $3, 'text', $4)`,
      [req.tenantId, quote.lead_id, `Quotation ${quote.quote_number} sent`, req.user.id]
    );

    // Activity
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by)
       VALUES ($1, $2, 'quotation_sent', $3, $4)`,
      [req.tenantId, quote.lead_id, `Quotation ${quote.quote_number} sent`, req.user.id]
    );

    res.json({ quotation: quote, whatsapp_url: waLink });
  } catch (error) {
    console.error('Send quotation error:', error);
    res.status(500).json({ error: 'Failed to send.' });
  }
};

// POST /api/quotations/:id/accept
const acceptQuotation = async (req, res) => {
  try {
    const result = await query(
      `UPDATE quotations SET status = 'accepted', accepted_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [req.params.id, req.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found.' });

    // Move lead to "Won" stage
    await query(
      `UPDATE leads SET stage = 'Won', won_at = NOW(), deal_value = $1
       WHERE id = $2 AND tenant_id = $3`,
      [result.rows[0].total, result.rows[0].lead_id, req.tenantId]
    );

    res.json({ quotation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed.' });
  }
};

// POST /api/quotations/:id/reject
const rejectQuotation = async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await query(
      `UPDATE quotations SET status = 'rejected', rejected_at = NOW(), notes = COALESCE(notes, '') || E'\nRejection reason: ' || $1
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [reason || 'No reason given', req.params.id, req.tenantId]
    );
    res.json({ quotation: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed.' });
  }
};

// DELETE /api/quotations/:id
const deleteQuotation = async (req, res) => {
  try {
    await query(
      `DELETE FROM quotations WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [req.params.id, req.tenantId]
    );
    res.json({ message: 'Quotation deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Cannot delete sent quotation.' });
  }
};

module.exports = {
  getQuotations, getQuotation, createQuotation, updateQuotation,
  sendQuotation, acceptQuotation, rejectQuotation, deleteQuotation,
};
