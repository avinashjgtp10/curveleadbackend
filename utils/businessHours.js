// True when "now" falls inside the tenant's configured WhatsApp business hours
// ({ start: 'HH:MM', end: 'HH:MM', days: [0-6, Sunday = 0], timezone }).
// With no hours configured, the business counts as always open.
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// `timezone` is the workspace timezone; it wins over the one saved inside the hours
// (older saves always stored Asia/Kolkata).
const isWithinBusinessHours = (hours, now = new Date(), timezone) => {
  if (!hours?.start || !hours?.end) return true;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || hours.timezone || 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const day = DAY_INDEX[get('weekday')];
  const minutes = parseInt(get('hour')) * 60 + parseInt(get('minute'));
  const toMin = (hhmm) => parseInt(hhmm.slice(0, 2)) * 60 + parseInt(hhmm.slice(3, 5));
  const start=toMin(hours.start),end=toMin(hours.end);
  const overnight=start>end;
  const businessDay=overnight&&minutes<end?(day+6)%7:day;
  if (Array.isArray(hours.days) && !hours.days.includes(businessDay)) return false;
  return overnight ? minutes>=start||minutes<end : minutes>=start&&minutes<end;
};

module.exports = { isWithinBusinessHours };
