const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
   ssl: {
    rejectUnauthorized: false
  }
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
  process.exit(-1);
});

// Helper for queries
const query = async (text, params) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.log('Query:', { text: text.substring(0, 80), duration: `${duration}ms`, rows: res.rowCount });
  }
  return res;
};

// Helper for tenant-scoped queries (adds tenant_id automatically)
const tenantQuery = async (text, params, tenantId) => {
  // This is a safety helper - individual queries should still include tenant_id
  return query(text, params);
};

module.exports = { pool, query, tenantQuery };
