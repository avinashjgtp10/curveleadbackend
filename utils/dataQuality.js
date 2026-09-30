const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const SOURCES = ['manual','meta_ads','google_ads','whatsapp','website','api','import','referral','organic','instagram','walkin','other'];
function normalizeSource(value) {
  const key = String(value || 'manual').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = { facebook: 'meta_ads', facebook_ads: 'meta_ads', meta: 'meta_ads', google: 'google_ads', walk_in: 'walkin' };
  return SOURCES.includes(aliases[key] || key) ? aliases[key] || key : 'other';
}
function normalizePhone(value) {
  let input = String(value ?? '').trim();
  if (/^91[6-9]\d{9}$/.test(input.replace(/[\s()-]/g, ''))) input = '+' + input;
  const parsed = parsePhoneNumberFromString(input, { defaultCountry: 'IN', extract: false });
  if (!parsed?.isValid() || parsed.ext) {
    const error = new Error('Enter a valid phone number, including country code for numbers outside India.');
    error.status = 422;
    throw error;
  }
  return parsed.number;
}
function normalizeLead(data) {
  return { ...data, phone: normalizePhone(data.phone), source: normalizeSource(data.source),
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
module.exports = { SOURCES, normalizeSource, normalizePhone, normalizeLead, statusChangeTitle, repairMojibake };
