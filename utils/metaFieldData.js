// Formats a Meta (Facebook) lead form's raw field_data into a readable notes string,
// so answers to custom form questions aren't lost when only name/phone/email are mapped to columns.
const formatLabel = (name) =>
  String(name).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const formatFieldDataNotes = (fieldData) => {
  const lines = (fieldData || [])
    .map((f) => `${formatLabel(f.name)}: ${f.values?.[0] ?? ''}`)
    .filter((line) => !line.endsWith(': '));
  if (!lines.length) return null;
  return `Meta Lead Form Submission:\n${lines.join('\n')}`;
};

module.exports = { formatFieldDataNotes };
