const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

// Normalizes to E.164 and classifies. Returns null for anything not a valid number.
const normalizeDestination = (raw, defaultCountry) => {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  const p = parsePhoneNumberFromString(raw.trim(), defaultCountry || undefined);
  if (!p || !p.isValid() || !p.country) return null;
  return { e164: p.number, country: p.country, type: p.getType() || 'UNKNOWN', digits: p.number.slice(1) };
};
module.exports = { normalizeDestination };
