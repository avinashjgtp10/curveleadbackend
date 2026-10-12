const test = require('node:test');
const assert = require('node:assert/strict');
const { describeStatusError } = require('../services/whatsappService');

test('131049 (ecosystem engagement) gets a plain explanation and keeps its code', () => {
  const text = describeStatusError({ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.', error_data: { details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.' } });
  assert.match(text, /^\[131049\] /);
  assert.match(text, /Meta chose not to deliver this marketing message/);
  assert.match(text, /Utility template/);
  assert.doesNotMatch(text, /In order to maintain/, "Meta's raw wording is replaced");
});

test('other known codes are explained; unknown codes keep Meta\'s own words', () => {
  assert.match(describeStatusError({ code: 131050, title: 'x' }), /stop receiving marketing/);
  assert.match(describeStatusError({ code: 131047, title: 'x' }), /24 hours/);
  assert.equal(describeStatusError({ code: 999999, title: 'Odd thing', error_data: { details: 'more info' } }), '[999999] Odd thing — more info');
  assert.equal(describeStatusError({ title: 'No code' }), 'No code');
  assert.equal(describeStatusError(undefined), null);
});
