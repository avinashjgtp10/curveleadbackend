const { query } = require('../config/db');
const { decryptSecret } = require('./cryptoSecrets');

// Resolves the Groq API key: an active platform integration managed in Super Admin → AI Agent wins,
// otherwise the GROQ_API_KEY environment variable. Cached briefly so AI calls do not each hit the DB.
const CACHE_MS = 60 * 1000;
let cache = { key: null, at: 0 };

const getGroqKey = async () => {
  if (Date.now() - cache.at < CACHE_MS) return cache.key;
  let key = null;
  try {
    const result = await query(
      `SELECT credential_encrypted FROM platform_ai_integrations
       WHERE provider = 'groq' AND integration_type = 'llm' AND status = 'active' LIMIT 1`
    );
    if (result.rows[0]) key = decryptSecret(result.rows[0].credential_encrypted);
  } catch (e) {
    // Table not migrated yet, or the stored value cannot be decrypted: fall back to the environment key.
    if (e.code !== '42P01') console.error('Platform AI key lookup failed:', e.message);
  }
  cache = { key: key || process.env.GROQ_API_KEY || null, at: Date.now() };
  return cache.key;
};

// Called after Super Admin adds / changes / removes an integration so the new key applies immediately.
const clearGroqKeyCache = () => { cache = { key: null, at: 0 }; };

module.exports = { getGroqKey, clearGroqKeyCache };
