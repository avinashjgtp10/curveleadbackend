const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { zonedParts, wallTimeToUtc, localeFromSettings } = require('./workspaceLocale');

// Per-step "only during business hours", judged in the LEAD'S local time. The lead's zone comes from their phone number's country,
// but only for countries that have a single time zone, so it is certain. Anything else (multi-zone countries such as the US or
// Australia, a number we can't read) falls back to the workspace's own zone rather than guessing.
const SINGLE_ZONE = {
  IN: 'Asia/Kolkata', AE: 'Asia/Dubai', SG: 'Asia/Singapore', GB: 'Europe/London', IE: 'Europe/Dublin', SA: 'Asia/Riyadh', QA: 'Asia/Qatar',
  KW: 'Asia/Kuwait', BH: 'Asia/Bahrain', OM: 'Asia/Muscat', PK: 'Asia/Karachi', BD: 'Asia/Dhaka', LK: 'Asia/Colombo', NP: 'Asia/Kathmandu',
  MY: 'Asia/Kuala_Lumpur', TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', PH: 'Asia/Manila', HK: 'Asia/Hong_Kong', JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul', CN: 'Asia/Shanghai', DE: 'Europe/Berlin', FR: 'Europe/Paris', NL: 'Europe/Amsterdam', IT: 'Europe/Rome',
  ZA: 'Africa/Johannesburg', KE: 'Africa/Nairobi', NG: 'Africa/Lagos', EG: 'Africa/Cairo', TR: 'Europe/Istanbul',
};

const leadTimezone = (lead, settings = {}) => {
  const locale = localeFromSettings(settings);
  try {
    const parsed = parsePhoneNumberFromString(String(lead?.phone || ''), locale.country || undefined);
    return (parsed?.country && SINGLE_ZONE[parsed.country]) || locale.timezone;
  } catch { return locale.timezone; }
};

// The same hours the workspace already uses for automation (Settings > automation business hours), with the same defaults.
const businessWindow = (settings = {}) => ({
  start: settings.automation_business_hours_start || '09:00',
  end: settings.automation_business_hours_end || '20:00',
});

const hhmmOf = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const inWindow = (timezone, { start, end }, now) => { const hhmm = hhmmOf(zonedParts(now, timezone).minutes); return hhmm >= start && hhmm < end; };

// The next moment the window opens in `timezone`: later today if it has not opened yet, otherwise tomorrow.
const nextWindowStart = (timezone, { start, end }, now) => {
  const { date, minutes } = zonedParts(now, timezone);
  const today = wallTimeToUtc(`${date}T${start}`, timezone);
  if (hhmmOf(minutes) >= end) return wallTimeToUtc(`${zonedParts(new Date(today.getTime() + 26 * 60 * 60 * 1000), timezone).date}T${start}`, timezone);
  return today;
};

// null = send now. A Date = hold the step until then. Steps without the flag are never held here.
const deferForStepHours = (step, lead, settings, now = new Date()) => {
  if (!step?.business_hours_only) return null;
  const timezone = leadTimezone(lead, settings);
  const window = businessWindow(settings);
  return inWindow(timezone, window, now) ? null : nextWindowStart(timezone, window, now);
};

module.exports = { leadTimezone, businessWindow, inWindow, nextWindowStart, deferForStepHours, SINGLE_ZONE };
