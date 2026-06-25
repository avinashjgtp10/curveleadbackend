const { Pool } = require('pg');
require('dotenv').config();

const POOL_CONFIG = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 900000,        // 15 min — outlasts scheduled job interval
  connectionTimeoutMillis: 15000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  ssl: { rejectUnauthorized: false },
};

let _pool = createPool();

function createPool() {
  const p = new Pool(POOL_CONFIG);
  p.on('error', (err) => console.error('❌ DB pool error:', err.message));
  return p;
}

async function resetPool() {
  console.warn('⚠️  DB pool dead — recreating connection pool...');
  try { await _pool.end(); } catch {}
  _pool = createPool();
}

const isConnError = (err) =>
  err.message?.includes('Connection terminated') ||
  err.message?.includes('connection timeout') ||
  err.code === 'ECONNRESET' ||
  err.code === 'ETIMEDOUT';

// Query helper — recreates pool and retries once on connection errors
const query = async (text, params, _retry = true) => {
  const start = Date.now();
  try {
    const res = await _pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development' && duration > 1000) {
      console.log('⚠️ Slow query:', { text: text.substring(0, 80), duration: `${duration}ms`, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    if (isConnError(error) && _retry) {
      await resetPool();
      await new Promise(r => setTimeout(r, 1000));
      return query(text, params, false);
    }
    console.error('❌ Query error:', error.message);
    console.error('   Query:', text.substring(0, 100));
    throw error;
  }
};

// Transaction helper
const transaction = async (callback) => {
  const client = await _pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { get pool() { return _pool; }, query, transaction };
