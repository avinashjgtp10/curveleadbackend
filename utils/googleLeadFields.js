// Parses Google Ads Lead Form webhook `user_column_data` — an array of
// { column_name, string_value } pairs — into standard fields we know how to map,
// plus a catch-all "custom" bag for everything else (unknown labels, future Google
// fields, tenant-defined custom questions). Never throws on missing/malformed input.

const norm = (s) => (s ?? '').toString().trim().toLowerCase();

// Order matters — first match wins. Covers Google's official COLUMN_NAME values
// (FULL_NAME, FIRST_NAME, ...) and free-text custom-question labels via substring
// heuristics for the salon-specific fields called out in the integration spec.
const STANDARD_MATCHERS = [
  { key: 'full_name', test: (n) => n === 'full_name' || n === 'full name' },
  { key: 'first_name', test: (n) => n === 'first_name' || n === 'first name' },
  { key: 'last_name', test: (n) => n === 'last_name' || n === 'last name' },
  { key: 'phone_number', test: (n) => n.includes('phone') },
  { key: 'email', test: (n) => n.includes('email') },
  { key: 'city', test: (n) => n === 'city' },
  { key: 'business_name', test: (n) => n.includes('company') || n.includes('business') || n.includes('salon') },
  { key: 'branch_count', test: (n) => n.includes('branch') },
  { key: 'current_software', test: (n) => n.includes('software') || n.includes('current tool') },
  { key: 'user_role', test: (n) => n.includes('role') || n.includes('designation') },
  { key: 'demo_preference', test: (n) => n.includes('demo') },
  { key: 'additional_requirements', test: (n) => n.includes('requirement') || n.includes('message') || n.includes('note') },
];

const parseUserColumnData = (userColumnData) => {
  const standard = {};
  const custom = {};
  if (!Array.isArray(userColumnData)) return { standard, custom };

  for (const col of userColumnData) {
    if (!col || typeof col !== 'object') continue;
    const name = col.column_name ?? col.columnName ?? '';
    const value = col.string_value ?? col.stringValue ?? '';
    if (!name) continue;

    const n = norm(name);
    const match = STANDARD_MATCHERS.find((m) => m.test(n));
    if (match && standard[match.key] === undefined) {
      standard[match.key] = value;
    } else {
      custom[name] = value;
    }
  }

  return { standard, custom };
};

module.exports = { parseUserColumnData };
