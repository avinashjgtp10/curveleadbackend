const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../utils/sequenceMedia');
const policy = require('../utils/automationPolicy');

const T = 'tenant-1';
const file = (over = {}) => ({ url: `https://b.s3.us-east-1.amazonaws.com/${m.mediaPrefix(T)}1-a.pdf`, name: 'prices.pdf', type: 'document', size: 1000, mime: 'application/pdf', ...over });

test('uploads are classified by extension with WhatsApp size limits', () => {
  assert.deepEqual(m.classifyUpload('Photo.JPG', 1000), { type: 'image', mime: 'image/jpeg' });
  assert.equal(m.classifyUpload('clip.mp4', 10 * 1024 * 1024).type, 'video');
  assert.equal(m.classifyUpload('deck.pptx', 1000).type, 'document');
  assert.match(m.classifyUpload('big.jpg', 6 * 1024 * 1024).error, /5 MB/);
  assert.match(m.classifyUpload('big.mp4', 17 * 1024 * 1024).error, /16 MB/);
  assert.match(m.classifyUpload('song.mp3', 10).error, /photo/i, 'audio and unknown types are refused');
  assert.match(m.classifyUpload('virus.exe', 10).error, /photo/i);
  assert.match(m.classifyUpload('noext', 10).error, /photo/i);
});

test('a step may carry one file from its own workspace', () => {
  const ok = [{ channel: 'whatsapp', message: 'Here you go', media: [file()] }];
  assert.equal(m.mediaError(ok, T), null);
  assert.equal(m.mediaError([{ channel: 'whatsapp', message: 'x' }], T), null, 'no media is fine');
  assert.match(m.mediaError([{ channel: 'whatsapp', media: [file(), file()] }], T), /one file per step/);
  assert.match(m.mediaError([{ channel: 'email', media: [file()] }], T), /only be sent on WhatsApp/);
  assert.match(m.mediaError([{ channel: 'whatsapp', always_template: true, media: [file()] }], T), /media header/);
  assert.match(m.mediaError([{ channel: 'whatsapp', media: [file()] }], 'tenant-2'), /isn't from this workspace/);
  assert.match(m.mediaError([{ channel: 'whatsapp', media: [file({ type: 'audio' })] }], T), /unsupported/);
  assert.match(m.mediaError([{ channel: 'whatsapp', message: 'x'.repeat(1025), media: [file()] }], T), /1024/);
});

test('a step with only a file needs no message; a step with neither is rejected', () => {
  const base = { delay_minutes: 0, channel: 'whatsapp' };
  assert.equal(policy.validateSequence({ steps: [{ ...base, message: '', media: [file()] }] }), null);
  assert.match(policy.validateSequence({ steps: [{ ...base, message: '' }] }), /needs a message or a file/);
});

test('stepAttachment tolerates old rows', () => {
  assert.equal(m.stepAttachment({}), null);
  assert.equal(m.stepAttachment({ media: null }), null);
  assert.equal(m.stepAttachment({ media: [] }), null);
  assert.equal(m.stepAttachment({ media: [{ type: 'bogus' }] }), null);
  assert.equal(m.stepAttachment({ media: [file()] }).name, 'prices.pdf');
  assert.equal(m.sendKind('document'), 'doc');
  assert.equal(m.sendKind('video'), 'video');
});
