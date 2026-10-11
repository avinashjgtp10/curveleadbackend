const { normalizePhone } = require('./dataQuality');

// Phone cells from a CSV/Excel import. Spreadsheets mangle phone numbers in predictable ways,
// so clean those first and explain, in plain words, the ones that can't be rescued.

// Drops a leading apostrophe (Excel's "text" marker) and the ".0" a numeric cell picks up
// ("919876543210.0" used to become 9198765432100 once the dot was stripped, which is invalid).
const cleanPhoneCell = (value) => String(value ?? '').trim()
  .replace(/^'(?=\+?\d)/, '')
  .replace(/^(\+?\d[\d\s()-]*)\.0+$/, '$1');

// Why a cell isn't a valid phone number, as something a person can act on.
const phoneHint = (raw) => {
  const v = String(raw ?? '').trim();
  if (!v) return 'The phone number is empty.';
  if (/^\d(\.\d+)?e\+?\d+$/i.test(v)) return 'The spreadsheet turned this number into scientific notation (like 9.19877E+11) and lost digits. Format the Phone column as Text, then export again.';
  if (/[a-z]/i.test(v)) return 'The phone contains letters. Use digits only (spaces, + and dashes are fine).';
  const digits = v.replace(/\D/g, '');
  if (digits.length < 8) return 'Too few digits for a phone number.';
  if (digits.length > 15) return 'Too many digits. Phone numbers have at most 15, including the country code. Two numbers in one cell?';
  return 'Not a valid number for this country. Numbers from other countries need their country code (like +971…).';
};

// { phone } for a good cell, or { error, hint } for a bad one.
const checkPhoneCell = (raw, country) => {
  try { return { phone: normalizePhone(cleanPhoneCell(raw), country) }; }
  catch (e) { return { error: e.message, hint: phoneHint(raw) }; }
};

module.exports = { cleanPhoneCell, phoneHint, checkPhoneCell };
