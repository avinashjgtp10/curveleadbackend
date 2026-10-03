// Batch 1 integration tests against a real PostgreSQL with the production schema plus
// migrations (ads phase 2–5 and batch1_*). Skipped unless BATCH1_TEST_DATABASE_URL is set:
//   pg_dump --schema-only <prod> | psql <test db>; psql -f models/migration_ads_phase{2..5}.sql
//   psql -f models/migration_batch1_*.sql; BATCH1_TEST_DATABASE_URL=postgres://… npm test
// Each test creates and removes its own workspace.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.BATCH1_TEST_DATABASE_URL;
let db = null;
if (url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });
  db = {
    pool,
    query: (text, params) => pool.query(text, params),
    transaction: async (fn) => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
      catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    },
  };
  // Point every module at the test database.
  const path = require.resolve('../config/db');
  require.cache[path] = { id: path, filename: path, loaded: true, exports: db };
}
const skip = !url && 'set BATCH1_TEST_DATABASE_URL to run';

const uid = () => crypto.randomUUID();
const workspace = async ({ country = 'IN' } = {}) => {
  const t = uid();
  await db.query(`INSERT INTO tenants (id, name, slug, email, settings) VALUES ($1, 'Batch1 test', $2, $3, $4)`,
    [t, `b1-${t.slice(0, 8)}`, `b1-${t.slice(0, 8)}@example.test`, JSON.stringify({ country, dedupe_mode: 'phone' })]);
  const users = [uid(), uid()];
  for (const [i, u] of users.entries()) {
    await db.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_active) VALUES ($1,$2,$3,$4,'x','staff',true)`,
      [u, t, `Rep ${i + 1}`, `rep${i}-${t.slice(0, 8)}@example.test`]);
  }
  const stages = [['New', 1, false, false], ['Qualified', 2, false, false], ['Won', 3, true, false], ['Lost', 4, false, true]];
  for (const [name, pos, won, lost] of stages) {
    await db.query('INSERT INTO lead_stages (tenant_id, name, pos, is_won, is_lost, is_active) VALUES ($1,$2,$3,$4,$5,true)', [t, name, pos, won, lost]);
  }
  return { t, users, cleanup: () => db.query('DELETE FROM tenants WHERE id = $1', [t]) };
};
const lead = async (t, { phone, stage = 'New', source = 'manual', created, assigned = null, meta = null, notes = null }) => (await db.query(
  `INSERT INTO leads (tenant_id, name, phone, source, stage, created_at, updated_at, assigned_to, meta_lead_id, notes)
   VALUES ($1,'Priya',$2,$3,$4,$5,$5,$6,$7,$8) RETURNING *`, [t, phone, source, stage, created, assigned, meta, notes])).rows[0];

test('phone formats of one number are one contact; the backfill soft-merges them with the agreed rules', { skip }, async () => {
  const { t, users, cleanup } = await workspace();
  try {
    // Same person three ways: legacy 10-digit (oldest, Won), 91-prefixed (newer, re-enquiry), E.164.
    const a = await lead(t, { phone: '9876543210', stage: 'Won', created: '2026-08-01T10:00:00Z', assigned: users[0], notes: 'Paid deposit' });
    const b = await lead(t, { phone: '919876543210', stage: 'New', created: '2026-09-20T10:00:00Z', source: 'meta_ads', meta: 'META-1' });
    const c = await lead(t, { phone: '+91 98765 43210', stage: 'Qualified', created: '2026-09-25T10:00:00Z', source: 'whatsapp', notes: 'Asked about price' });
    const other = await lead(t, { phone: '9123456789', created: '2026-09-01T10:00:00Z' });
    await db.query(`INSERT INTO whatsapp_messages (tenant_id, lead_id, direction, message) VALUES ($1,$2,'inbound','hi'),($1,$3,'inbound','hello again')`, [t, b.id, c.id]);
    await db.query(`INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, created_by, created_at) VALUES ($1,$2,'call','Called',$3,'2026-09-26T09:00:00Z')`, [t, c.id, users[1]]);

    const { analyseTenant } = require('../scripts/mergeDuplicateLeads');
    const leads = (await db.query('SELECT * FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL', [t])).rows;
    const { duplicates, reformat } = analyseTenant(leads, 'IN');
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0][0], '+919876543210');
    assert.equal(reformat.length, 4);

    const { applyMerge } = require('../services/leadMerge');
    await db.transaction(async (client) => {
      const rows = (await client.query('SELECT * FROM leads WHERE id = ANY($1::uuid[]) FOR UPDATE', [[a.id, b.id, c.id]])).rows;
      await applyMerge(client, { tenantId: t, leads: rows, reason: 'phone_backfill' });
    });

    const after = (await db.query('SELECT id, stage, assigned_to, merged_into_id, notes, source, meta_lead_id FROM leads WHERE tenant_id = $1 ORDER BY created_at', [t])).rows;
    const kept = after.find(r => r.id === a.id);
    assert.equal(kept.merged_into_id, null, 'oldest id survives');
    assert.equal(kept.stage, 'Won', 'a Won lead is never moved back to an earlier stage');
    assert.equal(kept.assigned_to, users[1], 'owner = most recent human activity');
    assert.equal(kept.source, 'manual', 'first-touch attribution kept');
    assert.match(kept.notes, /Paid deposit/); assert.match(kept.notes, /Asked about price/);
    for (const id of [b.id, c.id]) assert.equal(after.find(r => r.id === id).merged_into_id, a.id, 'soft-deleted, not removed');
    assert.equal(after.find(r => r.id === b.id).meta_lead_id, 'META-1', 'merged row keeps its own provider id');
    assert.equal((await db.query('SELECT count(*)::int n FROM whatsapp_messages WHERE lead_id = $1', [a.id])).rows[0].n, 2, 'one conversation thread');
    const merges = (await db.query('SELECT merged_lead_id, field_changes FROM lead_merges WHERE kept_lead_id = $1', [a.id])).rows;
    assert.equal(merges.length, 2);
    assert.ok(merges[0].field_changes.other_touches.some(x => x.source === 'meta_ads'), 'other touches logged');

    // Every list/count skips merged duplicates.
    const live = (await db.query('SELECT count(*)::int n FROM leads WHERE tenant_id = $1 AND merged_into_id IS NULL', [t])).rows[0].n;
    assert.equal(live, 2);
    assert.ok(other);

    // A re-delivered Meta lead resolves to the surviving lead instead of creating a new one.
    const { ingestLead } = require('../services/leadIngestion');
    const again = await ingestLead(t, { name: 'Priya', phone: '+919876543210', source: 'meta_ads', meta_lead_id: 'META-1' });
    assert.equal(again.duplicate, true);
    assert.equal(again.lead.id, a.id);
    // A new submission in another format matches the survivor too.
    const fresh = await ingestLead(t, { name: 'Priya', phone: '098765 43210', source: 'website' }, { submissionKey: null });
    assert.equal(fresh.lead.id, a.id);
  } finally { await cleanup(); }
});

test('WhatsApp inbound matching finds the contact whatever format it is stored in, never a merged duplicate', { skip }, async () => {
  const { t, cleanup } = await workspace();
  try {
    const old = await lead(t, { phone: '9876543210', created: '2026-08-01T10:00:00Z' });
    const dup = await lead(t, { phone: '+919876543210', created: '2026-09-01T10:00:00Z' });
    await db.query('UPDATE leads SET merged_into_id = $2, merged_at = now() WHERE id = $1', [dup.id, old.id]);
    const { normalizePhone, phoneDigitVariants } = require('../utils/dataQuality');
    const digits = phoneDigitVariants(normalizePhone('+919876543210'));
    const found = (await db.query(
      `SELECT id FROM leads WHERE tenant_id=$1 AND merged_into_id IS NULL AND phone_digits = ANY($2::text[]) ORDER BY created_at, id LIMIT 1`, [t, digits])).rows;
    assert.deepEqual(found.map(r => r.id), [old.id]);
  } finally { await cleanup(); }
});

test('a workspace in another country reads its own national numbers', { skip }, async () => {
  const { t, cleanup } = await workspace({ country: 'AE' });
  try {
    const { ingestLead } = require('../services/leadIngestion');
    const r = await ingestLead(t, { name: 'Omar', phone: '050 123 4567', source: 'manual' }, { submissionKey: null });
    assert.equal(r.lead.phone, '+971501234567');
  } finally { await cleanup(); }
});

test.after(async () => { if (db) await db.pool.end(); });
