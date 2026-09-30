// Formats a Meta (Facebook) lead form's raw field_data into a readable notes string,
// so answers to custom form questions aren't lost when only name/phone/email are mapped to columns.
const formatLabel = (name) =>
  String(name).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const PLATFORM_NAMES = { fb: 'Facebook', ig: 'Instagram' };

// meta = { platform, tenantName, campaignName, adsetName, adName } — all optional;
// only included attribution lines that actually have a value get rendered.
const formatFieldDataNotes = (fieldData, meta = {}) => {
  const lines = (fieldData || [])
    .map((f) => `${formatLabel(f.name)}: ${f.values?.[0] ?? ''}`)
    .filter((line) => !line.endsWith(': '));

  const blocks = [];

  const { platform, tenantName, campaignName, adsetName, adName } = meta;
  if (tenantName) {
    const platformLabel = PLATFORM_NAMES[platform] || 'Facebook';
    const attribution = [`${platformLabel} Lead via ${tenantName} CRM`];
    if (campaignName) attribution.push(`Campaign: ${campaignName}`);
    if (adsetName) attribution.push(`Adset: ${adsetName}`);
    if (adName) attribution.push(`Ad: ${adName}`);
    blocks.push(attribution.join('\n'));
  }

  if (lines.length) blocks.push(`Meta Lead Form Submission:\n${lines.join('\n')}`);

  if (fieldData?.length) blocks.push(`Raw Meta Field Data:\n${JSON.stringify(fieldData)}`);
  return blocks.length ? blocks.join('\n\n') : null;
};

module.exports = { formatFieldDataNotes };

function mapMetaFields(fieldData = []) {
  const result = { custom_fields: {} };
  for (const field of fieldData) {
    const key = String(field.name || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const value = field.values?.[0];
    if (value == null || value === '') continue;
    if (['business_name','company_name','salon_name','name_of_business'].includes(key)) result.business_name ??= value;
    else if (['city','town','your_city'].includes(key)) { result.city ??= value; result.location ??= value; }
    else if (/staff|chair/.test(key)) result.custom_fields[/chair/.test(key) ? 'number_of_chairs' : 'number_of_staff'] ??= value;
    else if (!['full_name','first_name','last_name','name','phone','phone_number','email'].includes(key)) result.custom_fields[key] = field.values?.length > 1 ? field.values : value;
  }
  return result;
}
module.exports.mapMetaFields = mapMetaFields;
