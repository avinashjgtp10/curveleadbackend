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

  return blocks.length ? blocks.join('\n\n') : null;
};

module.exports = { formatFieldDataNotes };
