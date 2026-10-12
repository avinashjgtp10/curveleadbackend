// Booked value: what the customer agreed to pay, frozen at the first Won (by the database, see
// migration_phase1_booking.sql). The only way to change it is an audited, append-only adjustment with a reason.
const { transaction, query } = require('../../config/db');
const { FinanceError } = require('./ledger');

const viewExists = async () => (await query(`SELECT to_regclass('v_lead_booked') IS NOT NULL AS present`)).rows[0].present;

const reasonOf = (v) => { const r = String(v == null ? '' : v).trim(); if (r.length < 3) throw new FinanceError(422, 'reason_required', 'A reason is required.'); return r.slice(0, 500); };
const valueOf = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 9999999999.99) throw new FinanceError(422, 'invalid_amount', 'The booked value must be 0 or more.');
  return Math.round(n * 100) / 100;
};

// The effective booked value of a lead (adjustment or snapshot), or null when it was never booked.
const getBooked = async ({ tenantId, leadId }) => {
  if (!(await viewExists())) return null;
  const b = (await query('SELECT value, currency, booked_basis, adjusted FROM v_lead_booked WHERE lead_id = $1 AND tenant_id = $2', [leadId, tenantId])).rows[0];
  if (!b) return null;
  const adj = (await query('SELECT new_value, new_currency, reason, evidence_ref, created_at FROM booking_adjustments WHERE lead_id = $1 AND tenant_id = $2 ORDER BY created_at DESC, id DESC LIMIT 20', [leadId, tenantId])).rows;
  return { value: b.value == null ? null : Number(b.value), currency: b.currency, basis: b.booked_basis, adjusted: b.adjusted,
    adjustments: adj.map((a) => ({ value: Number(a.new_value), currency: a.new_currency, reason: a.reason, evidence_ref: a.evidence_ref, at: a.created_at })) };
};

// Adjust the booked value. Only a lead that has actually been booked or reached a counted Won can be adjusted.
const adjust = ({ tenantId, leadId, userId, value, currency, reason, evidenceRef }) => transaction(async (c) => {
  if (!(await viewExists())) throw new FinanceError(503, 'booking_unavailable', 'Booked value is not set up in this database yet.');
  const why = reasonOf(reason); const next = valueOf(value);
  const cur = currency == null || currency === '' ? null : String(currency).trim().toUpperCase();
  if (cur && !/^[A-Z]{3}$/.test(cur)) throw new FinanceError(422, 'invalid_currency', 'The currency must be a 3-letter code such as INR.');
  const lead = (await c.query('SELECT id, merged_into_id FROM leads WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [leadId, tenantId])).rows[0];
  if (!lead) throw new FinanceError(404, 'lead_not_found', 'Lead not found.');
  if (lead.merged_into_id) throw new FinanceError(409, 'lead_merged', 'This lead was merged into another lead; adjust the surviving lead.');
  const current = (await c.query('SELECT value, currency FROM v_lead_booked WHERE lead_id = $1', [leadId])).rows[0];
  const won = (await c.query(`SELECT 1 FROM lead_milestone_events WHERE lead_id = $1 AND milestone = 'won' AND NOT suppressed LIMIT 1`, [leadId])).rows[0];
  if (!current && !won) throw new FinanceError(409, 'not_booked', 'This lead has not been marked Won, so it has no booked value to adjust.');
  const prev = current && current.value != null ? Number(current.value) : null;
  const dup = (await c.query(`SELECT id FROM booking_adjustments WHERE lead_id = $1 AND new_value = $2 AND COALESCE(new_currency, '') = COALESCE($3, '') AND created_at > now() - interval '5 seconds' LIMIT 1`, [leadId, next, cur])).rows[0];
  if (!dup) {
    await c.query(`INSERT INTO booking_adjustments (tenant_id, lead_id, previous_value, new_value, new_currency, reason, evidence_ref, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, leadId, prev, next, cur, why, evidenceRef ? String(evidenceRef).trim().slice(0, 200) : null, userId || null]);
    await c.query(`INSERT INTO financial_audit_log (tenant_id, lead_id, entity, entity_id, action, before, after, reason, actor) VALUES ($1,$2,'booking',$2,'booked_value_adjusted',$3,$4,$5,$6)`,
      [tenantId, leadId, JSON.stringify({ value: prev, currency: current ? current.currency : null }), JSON.stringify({ value: next, currency: cur || (current ? current.currency : null) }), why, userId || null]);
  }
  return { replayed: !!dup };
}).then(async (r) => ({ ...r, booked: await getBooked({ tenantId, leadId }) }));

module.exports = { getBooked, adjust, viewExists };
