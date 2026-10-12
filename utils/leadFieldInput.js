// Cleans the values of a lead update before they reach SQL. The edit form resends the whole lead, so a field the
// user left blank arrives as "" -- which PostgreSQL rejects for numbers, dates and ids, failing the whole save
// (and with it the stage change the user was making). Blank means "nothing entered", never an error.
const AMOUNT_FIELDS = ['deal_value', 'advance_received']; // DECIMAL(12,2) DEFAULT 0: blank means 0
const ID_FIELDS = ['assigned_to', 'campaign_id'];          // uuid references: blank means none
const DATE_FIELDS = ['expected_close_date'];               // DATE: blank means none
const MAX_AMOUNT = 9999999999.99;                           // DECIMAL(12,2)

const blank = (v) => v === null || (typeof v === 'string' && v.trim() === '');

// Mutates `body`. Returns an error message to answer with a 422, or null.
const cleanLeadInput = (body) => {
  if (!body || typeof body !== 'object') return null;
  for (const f of AMOUNT_FIELDS) {
    if (body[f] === undefined) continue;
    if (blank(body[f])) { body[f] = 0; continue; }
    const n = typeof body[f] === 'number' ? body[f] : typeof body[f] === 'string' ? Number(body[f].trim()) : NaN; // arrays/objects/booleans are never amounts
    if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return `${f === 'deal_value' ? 'Deal value' : 'Advance received'} must be a valid amount (0 or more).`;
    body[f] = n;
  }
  for (const f of [...ID_FIELDS, ...DATE_FIELDS]) if (body[f] !== undefined && blank(body[f])) body[f] = null;
  return null;
};

module.exports = { cleanLeadInput, AMOUNT_FIELDS, ID_FIELDS, DATE_FIELDS };
