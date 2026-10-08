const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const SOURCES = ['manual','meta_ads','google_ads','whatsapp','website','api','import','referral','organic','instagram','walkin','other'];
function normalizeSource(value) {
  const key = String(value || 'manual').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = { facebook: 'meta_ads', facebook_ads: 'meta_ads', meta: 'meta_ads', google: 'google_ads', walk_in: 'walkin' };
  return SOURCES.includes(aliases[key] || key) ? aliases[key] || key : 'other';
}
// E.164 (+<country><number>). Numbers without a country code are read in the workspace's
// country (defaultCountry, ISO 3166 alpha-2); digits that already carry a country code
// without "+" (e.g. WhatsApp's 919876543210) are tried as international next.
function normalizePhone(value, defaultCountry = 'IN') {
  const compact = String(value ?? '').trim().replace(/[\s().-]/g, '');
  const country = /^[A-Z]{2}$/.test(String(defaultCountry || '').toUpperCase()) ? String(defaultCountry).toUpperCase() : 'IN';
  const attempts = compact.startsWith('+') ? [[compact]]
    : compact.startsWith('00') ? [['+' + compact.slice(2)]]
    : [[compact, country], ...(/^\d{11,15}$/.test(compact) ? [['+' + compact]] : [])];
  for (const [input, defaultCountry] of attempts) {
    const parsed = parsePhoneNumberFromString(input, { ...(defaultCountry ? { defaultCountry } : {}), extract: false });
    if (parsed?.isValid() && !parsed.ext) return parsed.number;
  }
  const error = new Error('Enter a valid phone number, including the country code for numbers from another country.');
  error.status = 422;
  throw error;
}
// Digit strings a legacy (pre-E.164) row could hold for this number: full international
// digits, the national number, and the national number with a trunk 0.
function phoneDigitVariants(e164) {
  const parsed = parsePhoneNumberFromString(e164);
  const all = e164.replace(/\D/g, '');
  return parsed ? [...new Set([all, parsed.nationalNumber, `0${parsed.nationalNumber}`])] : [all];
}
function normalizeLead(data, defaultCountry = 'IN') {
  return { ...data, phone: normalizePhone(data.phone, defaultCountry), source: normalizeSource(data.source),
    name: String(data.name || 'Unknown').normalize('NFKC').trim(),
    email: data.email ? String(data.email).trim().toLowerCase() : null };
}
function statusChangeTitle(before, after, kind = 'Status') {
  const label = value => String(value ?? '').trim() || 'Not set';
  return label(before) === label(after) ? null : `${kind} changed: ${label(before)} → ${label(after)}`;
}
// Decode only reversible, recognizable UTF-8-as-Windows-1252 runs. Never guess missing bytes.
function repairMojibake(value) {
  if (typeof value !== 'string') return value;
  const bytes = new Map(Array.from({ length: 256 }, (_, i) => [String.fromCharCode(i), i]));
  const cp1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
  Array.from(cp1252).forEach((char, i) => bytes.set(char, i + 128));
  return value.replace(/[\u0080-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2010-\u203a\u20ac\u2122]+/g, run => {
    if (!/[ÃÂâð]/.test(run) || Array.from(run).some(c => !bytes.has(c))) return run;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(Array.from(run, c => bytes.get(c)))); }
    catch { return run; }
  });
}
module.exports = { SOURCES, normalizeSource, normalizePhone, phoneDigitVariants, normalizeLead, statusChangeTitle, repairMojibake };
