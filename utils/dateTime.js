const validAppointmentDate = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0;
const formatDateTime = (value, tz = 'Asia/Kolkata') => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'No date';
  try { new Intl.DateTimeFormat('en-IN', { timeZone: tz }); } catch { tz = 'Asia/Kolkata'; }
  return new Date(value).toLocaleString('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
};
module.exports = { validAppointmentDate, formatDateTime };
