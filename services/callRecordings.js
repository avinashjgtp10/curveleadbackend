const net = require('net');
const dns = require('dns').promises;
const axios = require('axios');

// Copies a finished call's recording into our own storage. Provider links expire and the
// provider decides how long it keeps audio; our copy lives under our retention rules.
//
// The recording URL arrives in a webhook, so it is untrusted: only public https addresses are
// fetched, every redirect is re-checked, and size and type are capped.

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// Loopback, private, link-local, CGNAT, multicast and other non-public addresses.
const isPrivateAddress = (ip) => {
  const v = String(ip || '');
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  if (net.isIPv6(v)) {
    const l = v.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true; // not an address we understand: treat as unsafe
};

// Throws unless `url` is https and every address it resolves to is public.
const assertPublicHttpsUrl = async (url, lookup = (host) => dns.lookup(host, { all: true })) => {
  let u;
  try { u = new URL(url); } catch { throw new Error('Recording link is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new Error('Recording link must use https.');
  if (u.username || u.password) throw new Error('Recording link must not contain credentials.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host);
  if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) throw new Error('Recording link points to a non-public address.');
  return u;
};

const EXT_BY_MIME = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'video/mp4': 'mp4', 'video/webm': 'webm' };
const extFor = (mime, url) => {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (EXT_BY_MIME[m]) return EXT_BY_MIME[m];
  const fromUrl = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(String(url || ''));
  return fromUrl && ['mp3', 'wav', 'ogg', 'webm', 'm4a', 'aac', 'mp4'].includes(fromUrl[1].toLowerCase()) ? fromUrl[1].toLowerCase() : 'mp3';
};
const isAudioLike = (mime) => { const m = String(mime || '').split(';')[0].trim().toLowerCase(); return !m || m.startsWith('audio/') || m.startsWith('video/') || m === 'application/octet-stream'; };

const defaultFetch = (url) => axios.get(url, {
  responseType: 'arraybuffer', timeout: 60000, maxRedirects: 0, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES,
  validateStatus: (s) => s >= 200 && s < 400,
});

// → { url, bytes, mime }. Throws (callers treat that as "keep the provider's link").
const archiveRecording = async ({ tenantId, callId, url }, deps = {}) => {
  const fetchFile = deps.fetchFile || defaultFetch;
  const lookup = deps.lookup;
  const upload = deps.upload || ((buffer, key, mime) => require('../config/s3').uploadToS3(buffer, key, mime));

  let current = (await assertPublicHttpsUrl(url, lookup)).href;
  let response;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetchFile(current);
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers?.location;
      if (!next || hop === MAX_REDIRECTS) throw new Error('Too many redirects fetching the recording.');
      current = (await assertPublicHttpsUrl(new URL(next, current).href, lookup)).href;
      continue;
    }
    break;
  }
  const mime = String(response.headers?.['content-type'] || '');
  if (!isAudioLike(mime)) throw new Error(`Unexpected recording type: ${mime}`);
  const buffer = Buffer.from(response.data);
  if (!buffer.length) throw new Error('The recording is empty.');
  if (buffer.length > MAX_BYTES) throw new Error('The recording is too large to archive.');

  const key = `call-recordings/${tenantId}/${callId}.${extFor(mime, current)}`;
  const stored = await upload(buffer, key, mime.split(';')[0].trim() || 'audio/mpeg');
  return { url: stored, bytes: buffer.length, mime };
};

module.exports = { archiveRecording, assertPublicHttpsUrl, isPrivateAddress, extFor, MAX_BYTES };
