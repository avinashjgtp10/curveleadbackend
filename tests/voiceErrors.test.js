const test = require('node:test');
const assert = require('node:assert/strict');
const { describeError } = require('../services/voiceCalling/errors');

test('errors log their stack; odd throwables still produce a useful line', () => {
  assert.match(describeError(new Error('boom')), /Error: boom[\s\S]*at /);
  assert.equal(describeError('plain string'), 'plain string');
  assert.equal(describeError(undefined), 'undefined');
  assert.equal(describeError(null), 'null');
  assert.match(describeError({ code: '23505', detail: 'x' }), /23505/);
  assert.ok(describeError('x'.repeat(5000)).length <= 500);
  assert.ok(describeError({ a: 'y'.repeat(5000) }).length <= 500);
});
test('a thrown object with no message is no longer logged as "undefined"', () => {
  assert.notEqual(describeError({ status: 500 }), 'undefined');
  assert.match(describeError(Object.assign(new Error(''), { code: 'ECONNREFUSED' })), /Error/);
});

const { where } = require('../services/voiceCalling/errors');
test('the request location in log lines never throws and drops the query string', () => {
  assert.equal(where({ method: 'POST', originalUrl: '/api/voice/calls?token=secret' }), 'POST /api/voice/calls');
  assert.equal(where({}), '? ');
  assert.equal(where(undefined), '? ');
});
