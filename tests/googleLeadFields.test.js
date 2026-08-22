const assert = require('assert');
const { parseUserColumnData } = require('../utils/googleLeadFields');

function run(name, fn) {
  fn();
  console.log(`ok - ${name}`);
}

run('maps standard Google COLUMN_NAME fields', () => {
  const { standard, custom } = parseUserColumnData([
    { column_name: 'FULL_NAME', string_value: 'Rahul Sharma' },
    { column_name: 'PHONE_NUMBER', string_value: '9876543210' },
    { column_name: 'EMAIL', string_value: 'rahul@example.com' },
    { column_name: 'CITY', string_value: 'Pune' },
  ]);
  assert.strictEqual(standard.full_name, 'Rahul Sharma');
  assert.strictEqual(standard.phone_number, '9876543210');
  assert.strictEqual(standard.email, 'rahul@example.com');
  assert.strictEqual(standard.city, 'Pune');
  assert.deepStrictEqual(custom, {});
});

run('maps salon-specific custom questions via substring heuristics', () => {
  const { standard } = parseUserColumnData([
    { column_name: 'How many branches do you have?', string_value: '3' },
    { column_name: 'What software do you currently use?', string_value: 'Excel' },
    { column_name: 'Your role', string_value: 'Owner' },
    { column_name: 'Preferred demo time', string_value: 'Weekday evenings' },
    { column_name: 'Any additional requirements?', string_value: 'Multi-branch billing' },
    { column_name: 'Salon Name', string_value: 'Glow Studio' },
  ]);
  assert.strictEqual(standard.branch_count, '3');
  assert.strictEqual(standard.current_software, 'Excel');
  assert.strictEqual(standard.user_role, 'Owner');
  assert.strictEqual(standard.demo_preference, 'Weekday evenings');
  assert.strictEqual(standard.additional_requirements, 'Multi-branch billing');
  assert.strictEqual(standard.business_name, 'Glow Studio');
});

run('unmatched and future/unknown fields fall into custom bag, not dropped', () => {
  const { standard, custom } = parseUserColumnData([
    { column_name: 'FULL_NAME', string_value: 'Priya' },
    { column_name: 'SOME_FUTURE_GOOGLE_FIELD', string_value: 'abc123' },
    { column_name: 'Favourite colour', string_value: 'Blue' },
  ]);
  assert.strictEqual(standard.full_name, 'Priya');
  assert.strictEqual(custom['SOME_FUTURE_GOOGLE_FIELD'], 'abc123');
  assert.strictEqual(custom['Favourite colour'], 'Blue');
});

run('does not throw on missing, undefined, or malformed input', () => {
  assert.deepStrictEqual(parseUserColumnData(undefined), { standard: {}, custom: {} });
  assert.deepStrictEqual(parseUserColumnData(null), { standard: {}, custom: {} });
  assert.deepStrictEqual(parseUserColumnData('not-an-array'), { standard: {}, custom: {} });
  assert.deepStrictEqual(parseUserColumnData([]), { standard: {}, custom: {} });
  const { standard, custom } = parseUserColumnData([
    null,
    undefined,
    'not-an-object',
    { column_name: '', string_value: 'ignored, no name' },
    { string_value: 'also ignored, no column_name key at all' },
    { column_name: 'FULL_NAME' }, // missing string_value -> empty string, not dropped
  ]);
  assert.strictEqual(standard.full_name, '');
  assert.deepStrictEqual(custom, {});
});

run('first match wins on duplicate column names, second occurrence goes to custom', () => {
  const { standard, custom } = parseUserColumnData([
    { column_name: 'EMAIL', string_value: 'first@example.com' },
    { column_name: 'EMAIL', string_value: 'second@example.com' },
  ]);
  assert.strictEqual(standard.email, 'first@example.com');
  assert.strictEqual(custom['EMAIL'], 'second@example.com');
});

console.log('All googleLeadFields tests passed.');
