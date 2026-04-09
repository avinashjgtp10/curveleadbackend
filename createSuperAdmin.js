// Run: node createSuperAdmin.js
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

(async () => {
  try {
    // Check if super admin already exists
    const exists = await pool.query("SELECT id FROM users WHERE role = 'super_admin'");
    if (exists.rows.length > 0) {
      console.log('⚠️  Super admin already exists.');
      process.exit();
    }

    // Get first tenant
    const tenantResult = await pool.query('SELECT id FROM tenants LIMIT 1');
    if (tenantResult.rows.length === 0) {
      console.log('⚠️  No tenant found. Please signup first, then run this script.');
      process.exit();
    }

    const tenantId = tenantResult.rows[0].id;
    const hash = await bcrypt.hash('Admin@123', 12);

    await pool.query(
      `INSERT INTO users (tenant_id, name, email, phone, password_hash, role)
       VALUES ($1, 'Super Admin', 'admin@curvelead.in', '0000000000', $2, 'super_admin')`,
      [tenantId, hash]
    );

    console.log('');
    console.log('✅ Super Admin created successfully!');
    console.log('   Email:    admin@curvelead.in');
    console.log('   Password: Admin@123');
    console.log('   ⚠️  Change this password after first login!');
    console.log('');
  } catch (error) {
    console.error('Error:', error.message);
  }
  process.exit();
})();
