const { query } = require('../config/db');

const getAll = async (req, res) => {
  try {
    const { lead_id, status } = req.query;
    let where = 'WHERE tenant_id = $1';
    const params = [req.tenantId];
    if (lead_id) { where += ` AND lead_id = $${params.length + 1}`; params.push(lead_id); }
    if (status)  { where += ` AND status = $${params.length + 1}`; params.push(status); }

    const result = await query(`SELECT * FROM quotations ${where} ORDER BY created_at DESC`, params);
    res.json({ quotations: result.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// Public endpoint — no auth required, used for lead-facing view link
const getPublic = async (req, res) => {
  try {
    const result = await query('SELECT * FROM quotations WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ quotation: result.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const getOne = async (req, res) => {
  try {
    const result = await query('SELECT * FROM quotations WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    res.json({ quotation: result.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const create = async (req, res) => {
  try {
    const { lead_id, title, items = [], discount_percent = 0, tax_percent = 18, valid_until, terms, notes } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required.' });

    // Fetch lead + tenant info
    const [leadRes, tenantRes] = await Promise.all([
      query('SELECT * FROM leads WHERE id = $1 AND tenant_id = $2', [lead_id, req.tenantId]),
      query('SELECT name, phone, address FROM tenants WHERE id = $1', [req.tenantId]),
    ]);
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead not found.' });
    const lead = leadRes.rows[0];
    const tenant = tenantRes.rows[0];

    // Generate quote number
    const countRes = await query('SELECT COUNT(*) FROM quotations WHERE tenant_id = $1', [req.tenantId]);
    const quoteNumber = `QUO-${new Date().getFullYear()}-${String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0')}`;

    // Calculate totals
    const subtotal = items.reduce((s, i) => s + ((parseFloat(i.quantity) || 0) * (parseFloat(i.price) || 0)), 0);
    const discountAmount = (subtotal * (parseFloat(discount_percent) || 0)) / 100;
    const taxAmount = ((subtotal - discountAmount) * (parseFloat(tax_percent) || 0)) / 100;
    const total = subtotal - discountAmount + taxAmount;

    const result = await query(
      `INSERT INTO quotations (tenant_id, lead_id, quote_number, title,
        lead_name, lead_phone, lead_email,
        business_name, business_phone, business_address,
        items, subtotal, discount_percent, discount_amount, tax_percent, tax_amount, total,
        valid_until, terms, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [req.tenantId, lead_id, quoteNumber, title,
        lead.name, lead.phone, lead.email,
        tenant.name, tenant.phone, tenant.address,
        JSON.stringify(items), subtotal, discount_percent, discountAmount, tax_percent, taxAmount, total,
        valid_until || null, terms || null, notes || null, req.user.id]
    );
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,'quotation','Quotation Created',$3,$4)`,
      [req.tenantId, lead_id, `Quotation ${quoteNumber} created — ₹${total.toLocaleString('en-IN')}`, req.user.id]
    );
    res.status(201).json({ quotation: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const update = async (req, res) => {
  try {
    const { title, items, discount_percent, tax_percent, valid_until, terms, notes } = req.body;

    const existing = await query('SELECT * FROM quotations WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found.' });
    if (existing.rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft quotations can be edited.' });

    const useItems = items || existing.rows[0].items;
    const useDiscount = discount_percent ?? existing.rows[0].discount_percent;
    const useTax = tax_percent ?? existing.rows[0].tax_percent;

    const subtotal = useItems.reduce((s, i) => s + ((parseFloat(i.quantity) || 0) * (parseFloat(i.price) || 0)), 0);
    const discountAmount = (subtotal * (parseFloat(useDiscount) || 0)) / 100;
    const taxAmount = ((subtotal - discountAmount) * (parseFloat(useTax) || 0)) / 100;
    const total = subtotal - discountAmount + taxAmount;

    const result = await query(
      `UPDATE quotations SET
        title=COALESCE($1,title), items=$2,
        discount_percent=$3, discount_amount=$4, tax_percent=$5, tax_amount=$6,
        subtotal=$7, total=$8,
        valid_until=COALESCE($9,valid_until), terms=COALESCE($10,terms), notes=COALESCE($11,notes),
        updated_at=NOW()
       WHERE id=$12 AND tenant_id=$13 RETURNING *`,
      [title, JSON.stringify(useItems), useDiscount, discountAmount, useTax, taxAmount, subtotal, total,
        valid_until || null, terms || null, notes || null, req.params.id, req.tenantId]
    );
    res.json({ quotation: result.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const send = async (req, res) => {
  try {
    const result = await query(
      `UPDATE quotations SET status='sent', updated_at=NOW() WHERE id=$1 AND tenant_id=$2 AND status='draft' RETURNING *`,
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(400).json({ error: 'Quotation not found or already sent.' });
    const q = result.rows[0];

    // Build formatted WhatsApp message
    const itemLines = (q.items || []).map(i =>
      `• ${i.name}${i.description ? ' (' + i.description + ')' : ''} — ₹${(parseFloat(i.quantity) * parseFloat(i.price)).toLocaleString('en-IN')}`
    ).join('\n');

    const msg = [
      `*Quotation #${q.quote_number}*`,
      `From: ${q.business_name}`,
      ``,
      `Dear ${q.lead_name},`,
      ``,
      `📦 *Items:*`,
      itemLines,
      ``,
      q.discount_percent > 0 ? `💸 Discount (${q.discount_percent}%): -₹${parseFloat(q.discount_amount).toLocaleString('en-IN')}` : null,
      `📊 Tax (${q.tax_percent}%): ₹${parseFloat(q.tax_amount).toLocaleString('en-IN')}`,
      `*💰 Total: ₹${parseFloat(q.total).toLocaleString('en-IN')}*`,
      q.valid_until ? `\n📅 Valid Until: ${new Date(q.valid_until).toLocaleDateString('en-IN')}` : null,
      q.terms ? `\n📋 Terms: ${q.terms}` : null,
      ``,
      `Thank you for choosing ${q.business_name}!`,
    ].filter(l => l !== null).join('\n');

    const frontendUrl = process.env.FRONTEND_URL || 'https://curvelead.com';
    const viewUrl = `${frontendUrl}/q/${q.id}`;

    const msgWithLink = msg + `\n\n📄 *View your quotation:*\n${viewUrl}`;

    const phone = (q.lead_phone || '').replace(/\D/g, '').slice(-10);
    const whatsapp_url = phone
      ? `https://wa.me/91${phone}?text=${encodeURIComponent(msgWithLink)}`
      : `https://wa.me/?text=${encodeURIComponent(msgWithLink)}`;

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,'quotation','Quotation Sent via WhatsApp',$3,$4)`,
      [req.tenantId, q.lead_id, `Quotation ${q.quote_number} (₹${parseFloat(q.total).toLocaleString('en-IN')}) sent to ${q.lead_name}`, req.user.id]
    );
    res.json({ quotation: q, whatsapp_url, message: msgWithLink });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const accept = async (req, res) => {
  try {
    const result = await query(
      `UPDATE quotations SET status='accepted', updated_at=NOW() WHERE id=$1 AND tenant_id=$2 RETURNING lead_id`,
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });

    const leadId = result.rows[0].lead_id;
    if (leadId) {
      await query(`UPDATE leads SET stage='won', updated_at=NOW() WHERE id=$1 AND tenant_id=$2`, [leadId, req.tenantId]);
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
         VALUES ($1,$2,'quotation','Quotation Accepted','Lead moved to Won stage',$3)`,
        [req.tenantId, leadId, req.user.id]
      );
    }
    res.json({ message: 'Quotation accepted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const reject = async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await query(
      `UPDATE quotations SET status='rejected', rejection_reason=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3 RETURNING id`,
      [reason || null, req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    const rejectedQuote = await query('SELECT lead_id, quote_number FROM quotations WHERE id=$1', [req.params.id]);
    if (rejectedQuote.rows[0]?.lead_id) {
      await query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
         VALUES ($1,$2,'quotation','Quotation Rejected',$3,$4)`,
        [req.tenantId, rejectedQuote.rows[0].lead_id, reason ? `Reason: ${reason}` : null, req.user.id]
      );
    }
    res.json({ message: 'Quotation rejected.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const remove = async (req, res) => {
  try {
    await query('DELETE FROM quotations WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ message: 'Deleted.' });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getAll, getPublic, getOne, create, update, send, accept, reject, delete: remove };
