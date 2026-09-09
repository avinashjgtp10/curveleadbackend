// Substitutes {{name}}/{{phone}}/{{email}}/{{city}}/{{source}} placeholders with lead fields.
const substituteVars = (message, lead) => message
  .replace(/\{\{name\}\}/gi, lead.name || '')
  .replace(/\{\{phone\}\}/gi, lead.phone || '')
  .replace(/\{\{email\}\}/gi, lead.email || '')
  .replace(/\{\{city\}\}/gi, lead.location || '')
  .replace(/\{\{source\}\}/gi, (lead.source || '').replace(/_/g, ' '));

// Quick WhatsApp/SMS templates (Settings → Templates) advertise single-brace
// placeholders instead — {name} {phone} {course} {course_fee} {course_duration}
// {business} {business_phone} — course fields come from the lead's linked
// course, business fields from the tenant.
const substituteTemplateVars = (message, lead = {}, tenant = {}) => {
  const courseFee = lead.fee_amount != null ? `₹${Number(lead.fee_amount).toLocaleString('en-IN')}` : '';
  const courseDuration = lead.duration_value ? `${lead.duration_value} ${lead.duration_unit || ''}`.trim() : '';
  return message
    .replace(/\{name\}/gi, lead.name || '')
    .replace(/\{phone\}/gi, lead.phone || '')
    .replace(/\{course_fee\}/gi, courseFee)
    .replace(/\{course_duration\}/gi, courseDuration)
    .replace(/\{course\}/gi, lead.course_name || '')
    .replace(/\{business_phone\}/gi, tenant.phone || '')
    .replace(/\{business\}/gi, tenant.name || '');
};

module.exports = { substituteVars, substituteTemplateVars };
