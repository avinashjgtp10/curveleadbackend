// Substitutes {{name}}/{{phone}}/{{email}}/{{city}}/{{source}} placeholders with lead fields.
const substituteVars = (message, lead) => message
  .replace(/\{\{name\}\}/gi, lead.name || '')
  .replace(/\{\{phone\}\}/gi, lead.phone || '')
  .replace(/\{\{email\}\}/gi, lead.email || '')
  .replace(/\{\{city\}\}/gi, lead.location || '')
  .replace(/\{\{source\}\}/gi, (lead.source || '').replace(/_/g, ' '));

module.exports = { substituteVars };
