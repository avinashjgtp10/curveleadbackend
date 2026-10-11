const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanPhoneCell, phoneHint, checkPhoneCell } = require('../utils/importPhone');

test('numeric cells that picked up ".0" are rescued instead of rejected', () => {
  assert.equal(cleanPhoneCell('919876543210.0'), '919876543210');
  assert.equal(cleanPhoneCell(" '+919876543210"), '+919876543210');
  assert.equal(cleanPhoneCell('98765 43210'), '98765 43210');
  assert.equal(checkPhoneCell('919876543210.0', 'IN').phone, '+919876543210');
  assert.equal(checkPhoneCell('9876543210', 'IN').phone, '+919876543210');
  assert.equal(checkPhoneCell('+971 50 123 4567', 'IN').phone, '+971501234567');
});

test('real problems stay rejected, each with a human reason', () => {
  const cases = [
    ['', /empty/], ['9.19877E+11', /scientific notation/], ['call me', /letters/], ['12345', /Too few/],
    ['9198765432101234567', /Too many/], ['5551234567', /country/],
  ];
  for (const [raw, re] of cases) {
    const r = checkPhoneCell(raw, 'IN');
    assert.ok(r.error, `${raw} should be invalid`);
    assert.match(r.hint, re, raw);
  }
  assert.match(phoneHint('1234567890123'), /country/);
});
