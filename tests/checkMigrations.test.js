const test = require('node:test');
const assert = require('node:assert/strict');
const { expectedObjects } = require('../scripts/checkMigrations');

test('finds the tables and columns a migration creates', () => {
  const sql = `-- a comment with CREATE TABLE ignored
    CREATE TABLE IF NOT EXISTS ad_lead_forms (id uuid);
    ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS budget_resource TEXT, ADD COLUMN provider VARCHAR(20);
    CREATE INDEX IF NOT EXISTS idx_x ON ad_campaigns(provider);`;
  assert.deepEqual(expectedObjects(sql), {
    tables: ['ad_lead_forms'],
    columns: [['ad_campaigns', 'budget_resource'], ['ad_campaigns', 'provider']],
  });
});

test('every real migration file parses', () => {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(dir).filter(f => /^migration_.*\.sql$/.test(f))) {
    assert.doesNotThrow(() => expectedObjects(fs.readFileSync(path.join(dir, f), 'utf8')), f);
  }
});
