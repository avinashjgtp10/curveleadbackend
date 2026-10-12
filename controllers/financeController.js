const { query } = require('../config/db');
const ledger = require('../services/finance/ledger');
const booking = require('../services/finance/booking');
const { hasPermission } = require('../utils/permissions');

// Finance endpoints (payment ledger). Mounted under /api/finance, behind the finance.ledger workspace flag and the
// finance.view / finance.manage permissions. Every query is scoped to req.tenantId; a guessed id is a 404.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (res, e) => {
  if (e instanceof ledger.FinanceError) {
    const { status, code, message, existing_payment_id } = e;
    return res.status(status).json({ error: message, code, ...(existing_payment_id ? { existing_payment_id } : {}) });
  }
  console.error('Finance error:', e && e.message);
  return res.status(500).json({ error: 'Failed. Please try again.' });
};
const bad = (res, message, status = 422) => res.status(status).json({ error: message });

// Staff see only their own leads, like everywhere else in the CRM.
const canSeeLead = async (req, leadId) => {
  const r = await query('SELECT assigned_to FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, req.tenantId]);
  if (!r.rows[0]) return false;
  return req.user.role !== 'staff' || r.rows[0].assigned_to === req.user.id;
};
const leadOfPayment = async (req, paymentId) => (await query('SELECT lead_id FROM lead_payments WHERE id = $1 AND tenant_id = $2', [paymentId, req.tenantId])).rows[0]?.lead_id || null;

const keyFrom = (req) => req.get('Idempotency-Key') || (req.body && req.body.idempotency_key);

// GET /api/finance/leads/:id
const getFinance = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid lead id.');
    if (!(await canSeeLead(req, req.params.id))) return bad(res, 'Lead not found.', 404);
    const data = await ledger.getLeadFinance({ tenantId: req.tenantId, leadId: req.params.id });
    // The screen needs to know whether to offer the write actions (the server enforces it either way).
    res.json({ ...data, can_manage: await hasPermission(req.user, 'finance.manage') });
  } catch (e) { fail(res, e); }
};

// POST /api/finance/leads/:id/payments
const createPayment = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid lead id.');
    if (!(await canSeeLead(req, req.params.id))) return bad(res, 'Lead not found.', 404);
    const b = req.body || {};
    const r = await ledger.recordPayment({ tenantId: req.tenantId, leadId: req.params.id, userId: req.user.id, amount: b.amount, currency: b.currency,
      paidOn: b.paid_on, paidOnBasis: b.paid_on_basis, method: b.method, reference: b.reference, notes: b.notes, status: b.status,
      confirmDuplicate: b.confirm_duplicate === true, idempotencyKey: keyFrom(req) });
    res.status(r.replayed ? 200 : 201).json({ payment: r.payment, replayed: r.replayed });
  } catch (e) { fail(res, e); }
};

// Payment-level actions share the same access check.
const onPayment = (action) => async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid payment id.');
    const leadId = await leadOfPayment(req, req.params.id);
    if (!leadId || !(await canSeeLead(req, leadId))) return bad(res, 'Payment not found.', 404);
    const b = req.body || {};
    const base = { tenantId: req.tenantId, paymentId: req.params.id, userId: req.user.id };
    res.json(await action(base, b, req));
  } catch (e) { fail(res, e); }
};

const refundPayment = onPayment(async (base, b, req) => {
  const r = await ledger.refund({ ...base, amount: b.amount, reason: b.reason, paidOn: b.paid_on, idempotencyKey: keyFrom(req) });
  return { refund: r.entry, replayed: r.replayed };
});
const reversePayment = onPayment(async (base, b, req) => {
  const r = await ledger.reverse({ ...base, reason: b.reason, idempotencyKey: keyFrom(req) });
  return { reversal: r.entry, replayed: r.replayed };
});
const completePayment = onPayment(async (base, b) => ledger.complete({ ...base, paidOn: b.paid_on, reason: b.reason }));
const cancelPayment = onPayment(async (base, b) => ledger.cancel({ ...base, reason: b.reason }));
const correctPayment = onPayment(async (base, b, req) => ledger.correct({ ...base, amount: b.amount, reason: b.reason, paidOn: b.paid_on, method: b.method, reference: b.reference, notes: b.notes, idempotencyKey: keyFrom(req) }));
const amendPayment = onPayment(async (base, b) => ledger.amendDetails({ ...base, reason: b.reason,
  patch: { paidOn: b.paid_on, paidOnBasis: b.paid_on_basis, method: b.method, reference: b.reference, notes: b.notes } }));

// POST /api/finance/leads/:id/booked-value/adjust { value, currency?, reason, evidence_ref? }
const adjustBooking = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return bad(res, 'Invalid lead id.');
    if (!(await canSeeLead(req, req.params.id))) return bad(res, 'Lead not found.', 404);
    const b = req.body || {};
    res.json(await booking.adjust({ tenantId: req.tenantId, leadId: req.params.id, userId: req.user.id, value: b.value, currency: b.currency, reason: b.reason, evidenceRef: b.evidence_ref }));
  } catch (e) { fail(res, e); }
};

// GET /api/finance/audit?lead_id=
const audit = async (req, res) => {
  try {
    const leadId = req.query.lead_id || null;
    if (leadId && !UUID.test(String(leadId))) return bad(res, 'Invalid lead id.');
    if (leadId && !(await canSeeLead(req, leadId))) return bad(res, 'Lead not found.', 404);
    if (!leadId && req.user.role === 'staff') return bad(res, 'Choose a lead.', 403);
    res.json({ entries: await ledger.getAudit({ tenantId: req.tenantId, leadId, limit: req.query.limit }) });
  } catch (e) { fail(res, e); }
};

module.exports = { adjustBooking, getFinance, createPayment, refundPayment, reversePayment, completePayment, cancelPayment, correctPayment, amendPayment, audit };
