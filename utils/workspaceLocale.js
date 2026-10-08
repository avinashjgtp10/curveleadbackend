const { query } = require('../config/db');

// Workspace country / currency / timezone (tenants.settings). Defaults keep existing
// India workspaces unchanged.
const DEFAULT_LOCALE = { country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' };

const validTimezone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const validCurrency = (c) => { try { return /^[A-Z]{3}$/.test(c || '') && !!new Intl.NumberFormat('en', { style: 'currency', currency: c }); } catch { return false; } };

const localeFromSettings = (settings = {}) => ({
  country: /^[A-Z]{2}$/.test(settings.country || '') ? settings.country : DEFAULT_LOCALE.country,
  currency: validCurrency(settings.currency) ? settings.currency : DEFAULT_LOCALE.currency,
  timezone: settings.timezone && validTimezone(settings.timezone) ? settings.timezone : DEFAULT_LOCALE.timezone,
});

const getWorkspaceLocale = async (tenantId, db = { query }) =>
  localeFromSettings((await db.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]?.settings || {});

// "en-IN", "en-AE", "en-US"… — English text with the country's digit grouping and date order.
const intlLocale = (country) => {
  const tag = `en-${country || DEFAULT_LOCALE.country}`;
  try { return Intl.NumberFormat.supportedLocalesOf([tag]).length ? tag : 'en'; } catch { return 'en'; }
};

// Money in a given currency. display 'code' ("INR 1,200.00") for places whose font can't
// draw every symbol (PDFs). Never converts — the amount is shown in the currency it was in.
const formatMoney = (amount, { currency = DEFAULT_LOCALE.currency, country, display = 'symbol', decimals } = {}) => {
  const n = amount == null || amount === '' ? NaN : Number(amount);
  if (!Number.isFinite(n)) return '—';
  const cur = validCurrency(currency) ? currency : DEFAULT_LOCALE.currency;
  const opts = { style: 'currency', currency: cur, currencyDisplay: display };
  if (decimals != null) Object.assign(opts, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  else if (Number.isInteger(n)) opts.minimumFractionDigits = 0;
  return new Intl.NumberFormat(intlLocale(country), opts).format(n);
};

const formatNumber = (n, { country } = {}) => new Intl.NumberFormat(intlLocale(country)).format(Number(n) || 0);

// A moment shown in the workspace's timezone, with the zone named so nobody has to guess.
const formatWhen = (value, { timezone = DEFAULT_LOCALE.timezone, country } = {}, opts = { dateStyle: 'medium', timeStyle: 'short' }) => {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return 'No date';
  const tz = validTimezone(timezone) ? timezone : DEFAULT_LOCALE.timezone;
  return new Intl.DateTimeFormat(intlLocale(country), { ...opts, timeZone: tz }).format(d);
};
const formatDate = (value, locale = {}, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => formatWhen(value, locale, opts);

// Calendar date and minutes past midnight of an instant, in a timezone.
const zonedParts = (date, timezone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
};

// "2026-10-04T15:30[:00]" read as wall-clock time in `timezone` → the UTC instant.
// Strings that already carry Z or an offset are taken as they are.
const wallTimeToUtc = (value, timezone = DEFAULT_LOCALE.timezone) => {
  if (typeof value !== 'string') return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) { const d = new Date(value); return Number.isFinite(d.getTime()) ? d : null; }
  const m = value.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/);
  if (!m) return null;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const tz = validTimezone(timezone) ? timezone : DEFAULT_LOCALE.timezone;
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(instant)).map(x => [x.type, x.value]));
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    instant += target - shown;
  }
  return new Date(instant);
};

module.exports = {
  DEFAULT_LOCALE, localeFromSettings, getWorkspaceLocale, validTimezone, validCurrency,
  intlLocale, formatMoney, formatNumber, formatWhen, formatDate, zonedParts, wallTimeToUtc,
};
