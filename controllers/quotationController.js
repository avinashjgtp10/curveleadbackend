const { query } = require('../config/db');
const PDFDocument = require('pdfkit');
const { localeFromSettings, getWorkspaceLocale, formatMoney, formatDate, intlLocale } = require('../utils/workspaceLocale');
const { countryProfile, bankLabel } = require('../utils/countryProfiles');
const { presentColumns } = require('../utils/schemaColumns');

// A quotation's own currency/country (snapshotted when it was written); quotes from before
// migration_batch1_locale.sql fall back to the workspace's.
const withLocale = (q, ws) => ({ ...q, currency: q.currency || ws.currency, business_country: q.business_country || ws.country });
// valid_until is a DATE column; config/db returns it as local midnight, so format it without a timezone shift.
const dateOnly = (d, country) => new Intl.DateTimeFormat(intlLocale(country), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d));
const money = (q, n, display) => formatMoney(n, { currency: q.currency, country: q.business_country, display });

const parseItems = (raw) => {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
};

const getAll = async (req, res) => {
  try {
    const { lead_id, status } = req.query;
    let where = 'WHERE tenant_id = $1';
    const params = [req.tenantId];
    if (lead_id) { where += ` AND lead_id = $${params.length + 1}`; params.push(lead_id); }
    if (status)  { where += ` AND status = $${params.length + 1}`; params.push(status); }

    const [result, ws] = await Promise.all([
      query(`SELECT * FROM quotations ${where} ORDER BY created_at DESC`, params), getWorkspaceLocale(req.tenantId)]);
    res.json({ quotations: result.rows.map(q => withLocale(q, ws)) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// Public endpoint — no auth required, used for lead-facing view link
const getPublic = async (req, res) => {
  try {
    const result = await query(
      `SELECT q.*,
              COALESCE(q.business_email,   t.email)       AS business_email,
              COALESCE(q.business_gst,     t.gst_number)  AS business_gst,
              COALESCE(q.business_pan,     t.pan_number)  AS business_pan,
              COALESCE(q.business_website, t.website)     AS business_website,
              COALESCE(q.business_logo,    t.logo_url)    AS business_logo,
              COALESCE(q.business_bank_details, t.settings->'bank_details', '{}') AS business_bank_details,
              t.settings AS tenant_settings
       FROM quotations q
       JOIN tenants t ON t.id = q.tenant_id
       WHERE q.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    const { tenant_settings, ...q } = result.rows[0];
    res.json({ quotation: { ...withLocale(q, localeFromSettings(tenant_settings || {})), items: parseItems(q.items) } });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const getOne = async (req, res) => {
  try {
    const result = await query('SELECT * FROM quotations WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    const q = withLocale(result.rows[0], await getWorkspaceLocale(req.tenantId));
    res.json({ quotation: { ...q, items: parseItems(q.items) } });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const create = async (req, res) => {
  try {
    const { lead_id, title, items = [], discount_percent = 0, valid_until, terms, notes } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required.' });

    const [leadRes, tenantRes] = await Promise.all([
      query('SELECT * FROM leads WHERE id = $1 AND tenant_id = $2', [lead_id, req.tenantId]),
      query('SELECT name, email, phone, address, logo_url, gst_number, pan_number, website, settings FROM tenants WHERE id = $1', [req.tenantId]),
    ]);
    if (!leadRes.rows.length) return res.status(404).json({ error: 'Lead not found.' });
    const lead = leadRes.rows[0];
    const tenant = tenantRes.rows[0];
    const bankDetails = tenant.settings?.bank_details || {};
    const ws = localeFromSettings(tenant.settings || {});
    const tax_percent = req.body.tax_percent ?? countryProfile(ws.country).default_tax_percent;
    const snap = await presentColumns('quotations', ['currency', 'business_country']);
    const extra = snap.has('currency') && snap.has('business_country') ? { currency: ws.currency, business_country: ws.country } : {};

    const countRes = await query('SELECT COUNT(*) FROM quotations WHERE tenant_id = $1', [req.tenantId]);
    const quoteNumber = `QUO-${new Date().getFullYear()}-${String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0')}`;

    const subtotal = items.reduce((s, i) => s + ((parseFloat(i.quantity) || 0) * (parseFloat(i.price) || 0)), 0);
    const discountAmount = (subtotal * (parseFloat(discount_percent) || 0)) / 100;
    const taxAmount = ((subtotal - discountAmount) * (parseFloat(tax_percent) || 0)) / 100;
    const total = subtotal - discountAmount + taxAmount;

    const result = await query(
      `INSERT INTO quotations (tenant_id, lead_id, quote_number, title,
        lead_name, lead_phone, lead_email,
        business_name, business_phone, business_address, business_email,
        business_gst, business_pan, business_website, business_logo,
        business_bank_details,
        items, subtotal, discount_percent, discount_amount, tax_percent, tax_amount, total,
        valid_until, terms, notes, created_by${Object.keys(extra).map(k => ', ' + k).join('')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27${Object.keys(extra).map((_, i) => ',$' + (28 + i)).join('')})
       RETURNING *`,
      [req.tenantId, lead_id, quoteNumber, title,
        lead.name, lead.phone, lead.email,
        tenant.name, tenant.phone, tenant.address, tenant.email,
        tenant.gst_number || null, tenant.pan_number || null, tenant.website || null, tenant.logo_url || null,
        JSON.stringify(bankDetails),
        JSON.stringify(items), subtotal, discount_percent, discountAmount, tax_percent, taxAmount, total,
        valid_until || null, terms || null, notes || null, req.user.id, ...Object.values(extra)]
    );
    const q = withLocale(result.rows[0], ws);
    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,'quotation','Quotation Created',$3,$4)`,
      [req.tenantId, lead_id, `Quotation ${quoteNumber} created — ${money(q, total)}`, req.user.id]
    );
    res.status(201).json({ quotation: { ...q, items: parseItems(q.items) } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

const update = async (req, res) => {
  try {
    const { title, items, discount_percent, tax_percent, valid_until, terms, notes } = req.body;

    const existing = await query('SELECT * FROM quotations WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found.' });
    if (existing.rows[0].status !== 'draft') return res.status(400).json({ error: 'Only draft quotations can be edited.' });

    const useItems = items || parseItems(existing.rows[0].items);
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
    const q = withLocale(result.rows[0], await getWorkspaceLocale(req.tenantId));
    res.json({ quotation: { ...q, items: parseItems(q.items) } });
  } catch (e) { res.status(500).json({ error: 'Failed.' }); }
};

const send = async (req, res) => {
  try {
    const result = await query(
      `UPDATE quotations SET status='sent', updated_at=NOW() WHERE id=$1 AND tenant_id=$2 AND status='draft' RETURNING *`,
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(400).json({ error: 'Quotation not found or already sent.' });
    const q = withLocale(result.rows[0], await getWorkspaceLocale(req.tenantId));
    const items = parseItems(q.items);

    const itemLines = items.map(i =>
      `• ${i.name}${i.description ? ' (' + i.description + ')' : ''} — ${money(q, (parseFloat(i.quantity) || 0) * (parseFloat(i.price) || 0))}`
    ).join('\n');

    const frontendUrl = process.env.FRONTEND_URL || 'https://curvelead.com';
    const apiUrl = process.env.API_URL || 'http://localhost:3002';
    const viewUrl = q.lead_id ? await require('../services/features').newContentLink({tenantId:req.tenantId,leadId:q.lead_id,kind:'quotation',contentId:q.id,title:String(q.quote_number),destination:`${frontendUrl}/q/${q.id}`}) : `${frontendUrl}/q/${q.id}`;
    const pdfDestination = `${apiUrl}/api/quotations/pdf/${q.id}`;
    const pdfUrl = q.lead_id ? await require('../services/features').newContentLink({tenantId:req.tenantId,leadId:q.lead_id,kind:'quotation',contentId:q.id,title:String(q.quote_number),destination:pdfDestination}) : pdfDestination;

    const msg = [
      `*Quotation #${q.quote_number}*`,
      `From: ${q.business_name}`,
      ``,
      `Dear ${q.lead_name},`,
      ``,
      `📦 *Items:*`,
      itemLines,
      ``,
      parseFloat(q.discount_percent) > 0 ? `💸 Discount (${q.discount_percent}%): -${money(q, parseFloat(q.discount_amount))}` : null,
      `📊 Tax (${q.tax_percent}%): ${money(q, parseFloat(q.tax_amount))}`,
      `*💰 Total: ${money(q, parseFloat(q.total))}*`,
      q.valid_until ? `\n📅 Valid Until: ${dateOnly(q.valid_until, q.business_country)}` : null,
      q.terms ? `\n📋 Terms: ${q.terms}` : null,
      ``,
      `Thank you for choosing ${q.business_name}!`,
      ``,
      `📄 *Download PDF:* ${pdfUrl}`,
      `🔗 *View Online:* ${viewUrl}`,
    ].filter(l => l !== null).join('\n');

    // Lead phones are stored in E.164, so the digits already include the country code.
    const phone = (q.lead_phone || '').replace(/\D/g, '');
    const whatsapp_url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`
      : `https://wa.me/?text=${encodeURIComponent(msg)}`;

    await query(
      `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, created_by)
       VALUES ($1,$2,'quotation','Quotation Sent via WhatsApp',$3,$4)`,
      [req.tenantId, q.lead_id, `Quotation ${q.quote_number} (${money(q, parseFloat(q.total))}) sent to ${q.lead_name}`, req.user.id]
    );
    res.json({ quotation: { ...q, items }, whatsapp_url, message: msg });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// Public PDF endpoint — no auth required
const getPdf = async (req, res) => {
  try {
    const result = await query('SELECT q.*, t.settings AS tenant_settings FROM quotations q JOIN tenants t ON t.id = q.tenant_id WHERE q.id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    const q = withLocale(result.rows[0], localeFromSettings(result.rows[0].tenant_settings || {}));
    const items = parseItems(q.items);
    // PDFKit's built-in font can't draw ₹/؋ etc., so amounts use the currency code ("INR 1,200.00").
    const pdfMoney = (n) => formatMoney(n, { currency: q.currency, country: q.business_country, display: 'code', decimals: 2 });
    const ws = localeFromSettings(q.tenant_settings || {});
    const pdfDate = (d) => formatDate(d, { country: q.business_country, timezone: ws.timezone });
    const taxLabels = Object.fromEntries(countryProfile(q.business_country).tax.map(f => [f.key, f.label]));

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="quotation-${q.quote_number}.pdf"`);
    doc.pipe(res);

    const L = 50, R = 545, W = R - L;

    // ── Header ───────────────────────────────────────────────────────────────
    const headerY = doc.y;
    doc.fontSize(18).fillColor('#4F46E5').text(q.business_name, L, headerY, { width: 280 });
    if (q.business_address) doc.fontSize(9).fillColor('#6B7280').text(q.business_address, L, doc.y, { width: 280 });
    if (q.business_phone)   doc.fontSize(9).fillColor('#6B7280').text(q.business_phone, L, doc.y, { width: 280 });
    if (q.business_email)   doc.fontSize(9).fillColor('#6B7280').text(q.business_email, L, doc.y, { width: 280 });
    if (q.business_website) doc.fontSize(9).fillColor('#6B7280').text(q.business_website, L, doc.y, { width: 280 });
    if (q.business_gst)     doc.fontSize(9).fillColor('#374151').text(`${taxLabels.gst_number || 'Tax ID'}: ${q.business_gst}`, L, doc.y, { width: 280 });
    if (q.business_pan)     doc.fontSize(9).fillColor('#374151').text(`${taxLabels.pan_number || 'PAN'}: ${q.business_pan}`, L, doc.y, { width: 280 });

    doc.fontSize(22).fillColor('#111827').text('QUOTATION', L, headerY, { align: 'right', width: W });
    doc.fontSize(10).fillColor('#6B7280')
       .text(`#${q.quote_number}`, L, headerY + 30, { align: 'right', width: W })
       .text(`Date: ${pdfDate(q.created_at)}`, L, headerY + 44, { align: 'right', width: W });
    if (q.valid_until) {
      doc.text(`Valid Until: ${dateOnly(q.valid_until, q.business_country)}`, L, headerY + 58, { align: 'right', width: W });
    }

    doc.y = Math.max(doc.y, headerY + 75);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#E5E7EB').lineWidth(1).stroke();
    doc.moveDown(0.6);

    // ── Bill To ──────────────────────────────────────────────────────────────
    doc.fontSize(8).fillColor('#9CA3AF').text('BILL TO', L);
    doc.fontSize(12).fillColor('#111827').text(q.lead_name, L);
    if (q.lead_phone) doc.fontSize(10).fillColor('#4B5563').text(q.lead_phone, L);
    if (q.lead_email) doc.fontSize(10).fillColor('#4B5563').text(q.lead_email, L);

    if (q.title) {
      doc.moveDown(0.5);
      doc.fontSize(13).fillColor('#1F2937').text(q.title, L);
    }
    doc.moveDown(0.8);

    // ── Items Table ───────────────────────────────────────────────────────────
    const C = { no: L, desc: L + 22, qty: R - 215, rate: R - 165, amt: R - 80 };
    const CW = { qty: 40, rate: 80, amt: 80 };
    const descW = C.qty - C.desc - 8;

    // Header row
    const thY = doc.y;
    doc.fontSize(9).fillColor('#6B7280')
       .text('#',           C.no,   thY, { width: 20 })
       .text('Description', C.desc, thY, { width: descW })
       .text('Qty',         C.qty,  thY, { width: CW.qty,  align: 'right' })
       .text('Rate',        C.rate, thY, { width: CW.rate, align: 'right' })
       .text('Amount',      C.amt,  thY, { width: CW.amt,  align: 'right' });

    doc.moveDown(0.4);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#D1D5DB').lineWidth(0.5).stroke();

    // Data rows
    items.forEach((item, i) => {
      doc.moveDown(0.4);
      const rowY = doc.y;
      const amt = (parseFloat(item.quantity) || 0) * (parseFloat(item.price) || 0);

      doc.fontSize(10).fillColor('#111827').text(String(i + 1), C.no, rowY, { width: 20 });
      doc.text(item.name, C.desc, rowY, { width: descW });
      if (item.description) doc.fontSize(8).fillColor('#6B7280').text(item.description, C.desc, doc.y, { width: descW });

      const rightY = rowY;
      doc.fontSize(10).fillColor('#374151')
         .text(String(item.quantity),                    C.qty,  rightY, { width: CW.qty,  align: 'right' })
         .text(pdfMoney(parseFloat(item.price)), C.rate, rightY, { width: CW.rate, align: 'right' })
         .text(pdfMoney(amt),                C.amt,  rightY, { width: CW.amt,  align: 'right' });

      doc.moveDown(0.3);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#F3F4F6').lineWidth(0.5).stroke();
    });

    doc.moveDown(0.8);

    // ── Totals ────────────────────────────────────────────────────────────────
    const TX = R - 215, TLW = 115, TVW = 100;

    const totalRow = (label, value, isBold) => {
      const y = doc.y;
      doc.fontSize(isBold ? 12 : 10)
         .fillColor(isBold ? '#4F46E5' : '#4B5563')
         .text(label, TX, y, { width: TLW })
         .text(value, TX + TLW, y, { width: TVW, align: 'right' });
      if (!isBold) doc.moveDown(0.3);
    };

    totalRow('Subtotal', pdfMoney(parseFloat(q.subtotal)));
    if (parseFloat(q.discount_percent) > 0) {
      totalRow(`Discount (${q.discount_percent}%)`, `-${pdfMoney(parseFloat(q.discount_amount))}`);
    }
    totalRow(`Tax (${q.tax_percent}%)`, pdfMoney(parseFloat(q.tax_amount)));

    doc.moveDown(0.2);
    doc.moveTo(TX, doc.y).lineTo(R, doc.y).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
    doc.moveDown(0.4);
    totalRow('Total', pdfMoney(parseFloat(q.total)), true);

    // ── Terms & Notes ─────────────────────────────────────────────────────────
    if (q.terms) {
      doc.moveDown(1.5);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
      doc.moveDown(0.5);
      doc.fontSize(8).fillColor('#9CA3AF').text('TERMS & CONDITIONS', L);
      doc.fontSize(9).fillColor('#4B5563').text(q.terms, L, doc.y, { width: W });
    }

    if (q.notes) {
      doc.moveDown(0.8);
      doc.fontSize(8).fillColor('#9CA3AF').text('NOTES', L);
      doc.fontSize(9).fillColor('#4B5563').text(q.notes, L, doc.y, { width: W });
    }

    // ── Bank / Payment Details ────────────────────────────────────────────────
    const bd = typeof q.business_bank_details === 'string'
      ? JSON.parse(q.business_bank_details || '{}')
      : (q.business_bank_details || {});
    const shown = ['account_holder', ...countryProfile(q.business_country).bank.map(f => f.key)];
    const bankKeys = [...new Set([...shown, ...Object.keys(bd)])].filter(k => typeof bd[k] === 'string' && bd[k].trim());
    const hasBankInfo = bankKeys.some(k => k !== 'account_holder');
    if (hasBankInfo) {
      doc.moveDown(1);
      doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
      doc.moveDown(0.5);
      doc.fontSize(8).fillColor('#9CA3AF').text('PAYMENT DETAILS', L);
      doc.moveDown(0.3);
      const col2X = L + 160;
      const bankRows = bankKeys.map(k => [bankLabel(q.business_country, k), bd[k]]);
      bankRows.forEach(([label, value]) => {
        const y = doc.y;
        doc.fontSize(9).fillColor('#9CA3AF').text(label, L, y, { width: 155 });
        doc.fontSize(9).fillColor('#111827').text(value, col2X, y, { width: W - 160 });
        doc.moveDown(0.3);
      });
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.moveDown(2);
    doc.fontSize(10).fillColor('#9CA3AF').text(`Thank you for choosing ${q.business_name}!`, L, doc.y, { align: 'center', width: W });

    doc.end();
  } catch (e) {
    console.error('PDF generation error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF.' });
  }
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
      const { changeLeadStage, wonStageName } = require('../utils/leadStage');
      await changeLeadStage({ tenantId: req.tenantId, leadId, newStageName: await wonStageName(req.tenantId) });
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

module.exports = { getAll, getPublic, getOne, create, update, send, getPdf, accept, reject, delete: remove };
