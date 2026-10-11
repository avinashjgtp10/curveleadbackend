const test = require('node:test');
const assert = require('node:assert/strict');
const { archiveRecording, assertPublicHttpsUrl, isPrivateAddress, extFor } = require('../services/callRecordings');

const publicLookup = async () => [{ address: '93.184.216.34' }];

test('non-public addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('only public https links are fetched', async () => {
  await assertPublicHttpsUrl('https://cdn.example.com/a.mp3', publicLookup);
  await assert.rejects(assertPublicHttpsUrl('http://cdn.example.com/a.mp3', publicLookup), /https/);
  await assert.rejects(assertPublicHttpsUrl('https://user:pw@cdn.example.com/a.mp3', publicLookup), /credentials/);
  await assert.rejects(assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data', publicLookup), /non-public/);
  await assert.rejects(assertPublicHttpsUrl('https://localhost/a.mp3', async () => [{ address: '127.0.0.1' }]), /non-public/);
  await assert.rejects(assertPublicHttpsUrl('https://sneaky.example.com/a.mp3', async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }]), /non-public/, 'any private answer blocks it');
  await assert.rejects(assertPublicHttpsUrl('not a url', publicLookup), /not a valid/);
});

test('extension comes from the type, then the link, then defaults to mp3', () => {
  assert.equal(extFor('audio/wav; charset=x', 'https://x/y'), 'wav');
  assert.equal(extFor('application/octet-stream', 'https://x/rec.m4a?sig=1'), 'm4a');
  assert.equal(extFor('', 'https://x/rec'), 'mp3');
});

const fileResponse = (over = {}) => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, data: Buffer.from('ID3-audio-bytes'), ...over });

test('a recording is downloaded and stored under the workspace and call', async () => {
  const stored = [];
  const out = await archiveRecording({ tenantId: 't1', callId: 'c1', url: 'https://cdn.example.com/rec.mp3' }, {
    lookup: publicLookup, fetchFile: async () => fileResponse(), upload: async (buf, key, mime) => { stored.push({ key, mime, bytes: buf.length }); return `https://bucket/${key}`; },
  });
  assert.equal(stored[0].key, 'call-recordings/t1/c1.mp3');
  assert.equal(stored[0].mime, 'audio/mpeg');
  assert.equal(out.url, 'https://bucket/call-recordings/t1/c1.mp3');
});

test('redirects are followed but each hop is checked, so a redirect into the network is refused', async () => {
  let calls = 0;
  const ok = await archiveRecording({ tenantId: 't', callId: 'c', url: 'https://a.example.com/r' }, {
    lookup: publicLookup, upload: async (b, k) => k,
    fetchFile: async () => (++calls === 1 ? { status: 302, headers: { location: 'https://b.example.com/real.mp3' }, data: Buffer.alloc(0) } : fileResponse()),
  });
  assert.ok(ok.url);
  await assert.rejects(archiveRecording({ tenantId: 't', callId: 'c', url: 'https://a.example.com/r' }, {
    lookup: async (host) => (host === 'evil.internal' ? [{ address: '10.0.0.9' }] : publicLookup()), upload: async () => 'x',
    fetchFile: async () => ({ status: 302, headers: { location: 'https://evil.internal/secret' }, data: Buffer.alloc(0) }),
  }), /non-public/);
});

test('non-audio, empty and endless-redirect responses are refused', async () => {
  const base = { lookup: publicLookup, upload: async () => 'x' };
  await assert.rejects(archiveRecording({ tenantId: 't', callId: 'c', url: 'https://a.example.com/r' }, { ...base, fetchFile: async () => fileResponse({ headers: { 'content-type': 'text/html' } }) }), /Unexpected recording type/);
  await assert.rejects(archiveRecording({ tenantId: 't', callId: 'c', url: 'https://a.example.com/r' }, { ...base, fetchFile: async () => fileResponse({ data: Buffer.alloc(0) }) }), /empty/);
  await assert.rejects(archiveRecording({ tenantId: 't', callId: 'c', url: 'https://a.example.com/r' }, { ...base, fetchFile: async () => ({ status: 302, headers: { location: 'https://a.example.com/r' }, data: Buffer.alloc(0) }) }), /Too many redirects/);
});
