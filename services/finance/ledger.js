// The payment ledger service. The money RULES live in the database (models/migration_phase1_lead_payments.sql):
// no deletes, immutable amounts, refund limits with row locks, audited detail changes, merged leads closed.
// This layer adds what a database cannot: idempotent retries, a soft duplicate check that needs a human
// confirmation, readable errors, and the multi-row flows (reverse + re-record = a correction).
//
// Every function takes the workspace ID first in its argument object and runs in ONE transaction. Nothing is
// ever deleted; a mistake is fixed by a reversal and a new entry, both stay visible.
const { transaction } = require('../../config/db');

class FinanceError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

// Messages raised by the database triggers start with "CODE: ...".
const DB_CODES = {
  LEAD_NOT_FOUND: [404, 'lead_not_found'], LEAD_MERGED: [409, 'lead_merged'], PARENT_NOT_FOUND: [404, 'payment_not_found'],
  PARENT_NOT_COMPLETED: [409, 'payment_not_completed'], CURRENCY_MISMATCH: [422, 'currency_mismatch'], OVER_REFUND: [409, 'amount_exceeds_remaining'],
  REVERSAL_AMOUNT: [409, 'reversal_must_cover_remaining'], IMMUTABLE: [409, 'immutable'], STATUS_FINAL: [409, 'status_final'], AUDITED_ONLY: [409, 'audited_only'],
};
const mapDbError = (e) => {
  if (e instanceof FinanceError) return e;
  const m = /^([A-Z_]+): ?([\s\S]*)$/.exec(String(e && e.message || ''));
  if (m && DB_CODES[m[1]]) return new FinanceError(DB_CODES[m[1]][0], DB_CODES[m[1]][1], m[2]);
  if (/never deleted/.test(String(e && e.message))) return new FinanceError(409, 'never_deleted', 'Payments are never deleted; record a reversal instead.');
  if (e && e.code === '23505') {
    if (/reference_uq/.test(e.constraint || e.message)) return new FinanceError(409, 'duplicate_reference', 'A payment with this method and reference already exists.');
    if (/one_reversal/.test(e.constraint || e.message)) return new FinanceError(409, 'already_reversed', 'This payment has already been reversed.');
    return new FinanceError(409, 'duplicate', 'This entry already exists.');
  }
  if (e && e.code === '23514') return new FinanceError(422, 'invalid_entry', 'The entry is not valid (check the amount, currency, date and reason).');
  return e;
};

const MAX_AMOUNT = 9999999999.99;
const money = (v, field = 'amount') => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) throw new FinanceError(422, 'invalid_amount', `The ${field} must be a positive amount.`);
  return Math.round(n * 100) / 100;
};
const currencyOf = (v) => {
  const c = String(v == null ? '' : v).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new FinanceError(422, 'invalid_currency', 'The currency must be a 3-letter code such as INR.');
  return c;
};
const keyOf = (v) => {
  const k = String(v == null ? '' : v).trim();
  if (k.length < 8 || k.length > 120) throw new FinanceError(400, 'idempotency_key_required', 'An Idempotency-Key of 8 to 120 characters is required for every change.');
  return k;
};
const dateOf = (v, field = 'paid_on') => {
  if (v == null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new FinanceError(422, 'invalid_date', `${field} must be a date like 2026-10-12.`);
  return String(v);
};
const text = (v, max = 500) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; };
const reasonOf = (v) => { const r = text(v); if (!r || r.length < 3) throw new FinanceError(422, 'reason_required', 'A reason is required.'); return r; };

// Who is acting and why: read by the database's audit trigger (transaction-local).
const setContext = async (client, { userId, reason = null, edit = false }) => {
  await client.query(`SELECT set_config('curvelead.actor', $1, true), set_config('curvelead.reason', $2, true), set_config('curvelead.payment_edit', $3, true)`,
    [userId ? String(userId) : '', reason || '', edit ? 'on' : 'off']);
};

// Dates leave the database as plain YYYY-MM-DD text, so no server timezone can shift a payment date by a day.
const COLUMNS = `id, tenant_id, lead_id, kind, status, amount, currency, adjustment_direction, parent_id, replaces_id, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, paid_on_basis,
  to_char(estimated_paid_on, 'YYYY-MM-DD') AS estimated_paid_on, method, reference, notes, reason, source, created_by, created_at, updated_at`;

const byKey = async (client, tenantId, key) => (await client.query(
  `SELECT ${COLUMNS} FROM lead_payments WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key])).rows[0] || null;

// A retry with the same key must be the SAME request; anything else is a mistake worth a loud 409.
const sameRequest = (row, want) => Object.entries(want).every(([k, v]) => v === undefined || String(row[k]) === String(v));

const insertEntry = async (client, e) => {
  const r = await client.query(
    `INSERT INTO lead_payments (tenant_id, lead_id, kind, status, amount, currency, adjustment_direction, parent_id, replaces_id, paid_on, paid_on_basis,
        estimated_paid_on, method, reference, notes, reason, idempotency_key, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING ${COLUMNS}`,
    [e.tenantId, e.leadId, e.kind, e.status || 'completed', e.amount, e.currency, e.adjustmentDirection || null, e.parentId || null, e.replacesId || null,
      e.paidOn || null, e.paidOnBasis || 'confirmed', e.estimatedPaidOn || null, e.method || null, e.reference || null, e.notes || null, e.reason || null,
      e.key, e.source || 'manual', e.userId || null]);
  if (r.rows[0]) return { entry: r.rows[0], replayed: false };
  const existing = await byKey(client, e.tenantId, e.key); // lost an idempotency race: return the winner
  return { entry: existing, replayed: true };
};

const run = async (fn, client) => {
  try { return client ? await fn(client) : await transaction(fn); } catch (e) { throw mapDbError(e); }
};

// ---- recording a payment ----------------------------------------------------------------------------------------------
// confirmDuplicate: the caller has been told a same-lead/amount/currency/date payment exists and insists.
const recordPayment = ({ tenantId, leadId, userId, amount, currency, paidOn, paidOnBasis = 'confirmed', method, reference, notes, idempotencyKey, status = 'completed', confirmDuplicate = false, client = null }) => run(async (c) => {
  const key = keyOf(idempotencyKey);
  const amt = money(amount); const cur = currencyOf(currency);
  if (!['completed', 'pending'].includes(status)) throw new FinanceError(422, 'invalid_status', 'A new payment is either completed or pending.');
  if (!['confirmed', 'estimated', 'unknown'].includes(paidOnBasis)) throw new FinanceError(422, 'invalid_date_basis', 'paid_on_basis must be confirmed, estimated or unknown.');
  const date = dateOf(paidOn);
  if (status === 'completed' && paidOnBasis === 'confirmed' && !date) throw new FinanceError(422, 'paid_on_required', 'A confirmed payment needs the date it was received.');

  const existing = await byKey(c, tenantId, key);
  if (existing) {
    if (!sameRequest(existing, { lead_id: leadId, amount: amt.toFixed(2), currency: cur, kind: 'payment' })) throw new FinanceError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different payment.');
    return { payment: existing, replayed: true };
  }
  let why = null;
  if (date && status !== 'cancelled') {
    const dup = (await c.query(
      `SELECT id FROM lead_payments WHERE tenant_id = $1 AND lead_id = $2 AND kind = 'payment' AND status IN ('pending','completed') AND amount = $3 AND currency = $4 AND paid_on = $5 LIMIT 1`,
      [tenantId, leadId, amt, cur, date])).rows[0];
    if (dup && !confirmDuplicate) throw new FinanceError(409, 'possible_duplicate', 'A payment with the same amount, currency and date was already recorded for this lead. Confirm to record it again.', { existing_payment_id: dup.id });
    if (dup) why = 'recorded again after a possible-duplicate warning was confirmed';
  }
  await setContext(c, { userId, reason: why });
  const { entry, replayed } = await insertEntry(c, { tenantId, leadId, userId, kind: 'payment', status, amount: amt, currency: cur, paidOn: date, paidOnBasis, method: text(method, 60), reference: text(reference, 120), notes: text(notes, 1000), key });
  return { payment: entry, replayed };
}, client);

// ---- refund / reversal -----------------------------------------------------------------------------------------------------
const loadPayment = async (c, tenantId, paymentId, lock = false) => {
  const r = (await c.query(`SELECT ${COLUMNS} FROM lead_payments WHERE id = $1 AND tenant_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [paymentId, tenantId])).rows[0];
  if (!r) throw new FinanceError(404, 'payment_not_found', 'Payment not found.');
  return r;
};

const refund = ({ tenantId, paymentId, userId, amount, reason, paidOn, idempotencyKey, client = null }) => run(async (c) => {
  const key = keyOf(idempotencyKey); const amt = money(amount); const why = reasonOf(reason); const date = dateOf(paidOn);
  const parent = await loadPayment(c, tenantId, paymentId);
  const existing = await byKey(c, tenantId, key);
  if (existing) {
    if (!sameRequest(existing, { parent_id: parent.id, amount: amt.toFixed(2), kind: 'refund' })) throw new FinanceError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request.');
    return { entry: existing, replayed: true };
  }
  await setContext(c, { userId, reason: why });
  return insertEntry(c, { tenantId, leadId: parent.lead_id, userId, kind: 'refund', amount: amt, currency: parent.currency, parentId: parent.id, paidOn: date, paidOnBasis: date ? 'confirmed' : 'unknown', reason: why, key });
}, client);

const reverse = ({ tenantId, paymentId, userId, reason, idempotencyKey, client = null }) => run(async (c) => {
  const key = keyOf(idempotencyKey); const why = reasonOf(reason);
  const parent = await loadPayment(c, tenantId, paymentId, true); // lock: the remaining amount must not move under us
  const existing = await byKey(c, tenantId, key);
  if (existing) {
    if (!sameRequest(existing, { parent_id: parent.id, kind: 'reversal' })) throw new FinanceError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request.');
    return { entry: existing, replayed: true };
  }
  const used = Number((await c.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM lead_payments WHERE parent_id = $1 AND kind IN ('refund','reversal') AND status IN ('pending','completed')`, [parent.id])).rows[0].s);
  const remaining = Math.round((Number(parent.amount) - used) * 100) / 100;
  if (remaining <= 0) throw new FinanceError(409, 'nothing_to_reverse', 'Nothing is left of this payment to reverse.');
  await setContext(c, { userId, reason: why });
  return insertEntry(c, { tenantId, leadId: parent.lead_id, userId, kind: 'reversal', amount: remaining, currency: parent.currency, parentId: parent.id, reason: why, paidOnBasis: 'unknown', key });
}, client);

// ---- pending entries ------------------------------------------------------------------------------------------------------------
const settlePending = (status) => ({ tenantId, paymentId, userId, reason = null, paidOn = null, client = null }) => run(async (c) => {
  const date = dateOf(paidOn);
  await setContext(c, { userId, reason: text(reason) });
  const r = await c.query(
    `UPDATE lead_payments SET status = $3, paid_on = COALESCE($4::date, paid_on) WHERE id = $1 AND tenant_id = $2 AND status = 'pending' RETURNING ${COLUMNS}`,
    [paymentId, tenantId, status, date]);
  if (r.rows[0]) return { payment: r.rows[0] };
  const cur = await loadPayment(c, tenantId, paymentId);
  throw new FinanceError(409, 'not_pending', `Only a pending entry can be ${status}; this one is ${cur.status}. A completed payment is reversed, never cancelled.`);
}, client);
const complete = settlePending('completed');
const cancel = settlePending('cancelled');

// ---- correcting a wrong amount: a reversal PLUS a new payment, atomic, both stay visible ----------------------------
const correct = ({ tenantId, paymentId, userId, amount, reason, idempotencyKey, paidOn, method, reference, notes, client = null }) => run(async (c) => {
  const key = keyOf(idempotencyKey); const why = reasonOf(reason); const amt = money(amount);
  const original = await loadPayment(c, tenantId, paymentId, true);
  if (original.kind !== 'payment' || original.status !== 'completed') throw new FinanceError(409, 'payment_not_completed', 'Only a completed payment can be corrected.');
  const reversal = await reverse({ tenantId, paymentId, userId, reason: `Correction: ${why}`, idempotencyKey: `${key}:reverse`, client: c });
  const date = dateOf(paidOn) || original.paid_on;
  await setContext(c, { userId, reason: why });
  const { entry, replayed } = await insertEntry(c, { tenantId, leadId: original.lead_id, userId, kind: 'payment', amount: amt, currency: original.currency, replacesId: original.id,
    paidOn: date ? String(date).slice(0, 10) : null, paidOnBasis: date ? original.paid_on_basis : 'unknown', method: text(method, 60) || original.method,
    reference: text(reference, 120), notes: text(notes, 1000) || `Corrects ${original.id}`, reason: why, key: `${key}:payment` });
  return { reversal: reversal.entry, payment: entry, replayed };
}, client);

// ---- audited changes of a COUNTED entry's details (date, method, reference, notes) -----------------------------------------
const amendDetails = ({ tenantId, paymentId, userId, reason, patch = {}, client = null }) => run(async (c) => {
  const cur = await loadPayment(c, tenantId, paymentId, true);
  const next = {
    paid_on: patch.paidOn !== undefined ? dateOf(patch.paidOn) : undefined,
    paid_on_basis: patch.paidOnBasis,
    method: patch.method !== undefined ? text(patch.method, 60) : undefined,
    reference: patch.reference !== undefined ? text(patch.reference, 120) : undefined,
    notes: patch.notes !== undefined ? text(patch.notes, 1000) : undefined,
  };
  if (next.paid_on_basis !== undefined && !['confirmed', 'estimated', 'unknown'].includes(next.paid_on_basis)) throw new FinanceError(422, 'invalid_date_basis', 'paid_on_basis must be confirmed, estimated or unknown.');
  const sets = []; const params = [paymentId, tenantId];
  for (const [col, v] of Object.entries(next)) if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
  if (!sets.length) throw new FinanceError(422, 'nothing_to_change', 'Nothing to change.');
  const counted = cur.status !== 'pending';
  const why = counted ? reasonOf(reason) : text(reason);
  await setContext(c, { userId, reason: why, edit: counted });
  const r = await c.query(`UPDATE lead_payments SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING ${COLUMNS}`, params);
  return { payment: r.rows[0] };
}, client);

// ---- reading -------------------------------------------------------------------------------------------------------------------------
// Everything about one lead's money. A merged lead is shown through its ROOT: all the person's payments, each still
// on the lead it was recorded on, totals per currency (never added across currencies).
const getLeadFinance = async ({ tenantId, leadId }) => {
  const { query } = require('../../config/db');
  const lead = (await query('SELECT id, merged_into_id, deal_value FROM leads WHERE id = $1 AND tenant_id = $2', [leadId, tenantId])).rows[0];
  if (!lead) throw new FinanceError(404, 'lead_not_found', 'Lead not found.');
  const rootId = lead.merged_into_id || lead.id;
  const [payments, totals] = await Promise.all([
    query(`SELECT ${COLUMNS} FROM lead_payments WHERE tenant_id = $1 AND lead_id IN (SELECT id FROM leads WHERE tenant_id = $1 AND (id = $2 OR merged_into_id = $2)) ORDER BY created_at, id`, [tenantId, rootId]),
    query(`SELECT currency, net, gross_paid, pending, payments FROM v_person_net_collected WHERE tenant_id = $1 AND root_lead_id = $2 ORDER BY currency`, [tenantId, rootId]),
  ]);
  const booked = await require('./booking').getBooked({ tenantId, leadId: rootId }).catch(() => null); // null until the booking migration is installed
  return {
    lead_id: lead.id, root_lead_id: rootId, merged: !!lead.merged_into_id, deal_value: lead.deal_value == null ? null : Number(lead.deal_value), booked,
    payments: payments.rows.map((p) => ({ ...p, amount: Number(p.amount) })),
    totals: totals.rows.map((t) => ({ currency: t.currency, net_collected: Number(t.net), gross_paid: Number(t.gross_paid), pending: Number(t.pending), payments: t.payments })),
  };
};

const getAudit = async ({ tenantId, leadId, limit = 200 }) => {
  const { query } = require('../../config/db');
  const r = await query(`SELECT id, lead_id, entity, entity_id, action, before, after, reason, actor, created_at FROM financial_audit_log
    WHERE tenant_id = $1 AND ($2::uuid IS NULL OR lead_id = $2::uuid) ORDER BY created_at DESC, id DESC LIMIT $3`, [tenantId, leadId || null, Math.min(Number(limit) || 200, 500)]);
  return r.rows;
};

module.exports = { FinanceError, mapDbError, recordPayment, refund, reverse, complete, cancel, correct, amendDetails, getLeadFinance, getAudit, money, currencyOf, keyOf, dateOf };
