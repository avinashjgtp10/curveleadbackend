const crypto = require('crypto');

// Derived once per process from JWT_SECRET via scrypt with a distinct salt/purpose
// string — domain-separates it from JWT signing without needing a dedicated
// encryption-key env var. Used to encrypt integration webhook keys at rest so an
// admin can re-reveal them later (unlike a hash, which is one-way).
const DERIVED_KEY = crypto.scryptSync(process.env.JWT_SECRET || 'dev-only-insecure-secret', 'curvelead-integration-secrets', 32);

const encryptSecret = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DERIVED_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
};

const decryptSecret = (encoded) => {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', DERIVED_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};

// Same shape as the existing REST API key generator (integrationController.js) —
// full entropy from crypto.randomBytes, no adaptive hashing needed for storage.
const generateWebhookKey = () => crypto.randomBytes(24).toString('hex');

// Hashes both sides to fixed-length digests before comparing, so callers never hit
// crypto.timingSafeEqual's "input buffers must have the same length" throw when the
// attacker-supplied string happens to differ in length from the real key.
const timingSafeEqualStrings = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const maskKey = (plaintext) => {
  if (!plaintext || plaintext.length < 12) return '••••••••';
  return `${plaintext.slice(0, 6)}${'•'.repeat(20)}${plaintext.slice(-4)}`;
};

// Versioned encryption for OAuth tokens (ad_oauth_tokens.key_version), so the key
// can move off JWT_SECRET without losing existing rows:
//   1 = key derived from JWT_SECRET (same as encryptSecret above)
//   2 = TOKEN_ENCRYPTION_KEY (base64, 32 bytes), used for new rows once it is set
const tokenKey = (version) => {
  if (version === 1) return DERIVED_KEY;
  if (version === 2) {
    const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    return key;
  }
  throw new Error(`Unknown token key version ${version}.`);
};
const currentTokenKeyVersion = () => (process.env.TOKEN_ENCRYPTION_KEY ? 2 : 1);

const encryptToken = (plaintext) => {
  const keyVersion = currentTokenKeyVersion();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(keyVersion), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'), keyVersion };
};

const decryptToken = (encoded, keyVersion = 1) => {
  const raw = Buffer.from(encoded, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(keyVersion), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
};

module.exports = { encryptSecret, decryptSecret, generateWebhookKey, timingSafeEqualStrings, maskKey, encryptToken, decryptToken, currentTokenKeyVersion };
