// Lead attribution against REAL PostgreSQL (throwaway schema in a throwaway curvelead_test_* database).
// Skipped unless PHASE1_TEST_DATABASE_URL is set; run with scripts/runPhase1SqlTests.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const url = process.env.PHASE1_TEST_DATABASE_URL;
const skip = !url && 'set PHASE1_TEST_DATABASE_URL (a throwaway curvelead_test_* database) to run';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('lead attribution: captured once in the database, original never rewritten, edits and late campaigns handled', { skip }, async (t) => {
  if (!/\/curvelead_test_[a-z0-9_]+(\?.*)?$/.test(url)) throw new Error('PHASE1_TEST_DATABASE_URL must point at a database named curvelead_test_*');
  const { Client } = require('pg');
  const schema = 'p1a_' + Date.now();
  const admin = new Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const c = new Client({ connectionString: url }); await c.connect(); await c.query(`SET search_path TO ${schema}; SET timezone='UTC'`);
  const T = '11111111-1111-1111-1111-111111111111';
  try {
    await c.query(`CREATE TABLE tenants(id uuid PRIMARY KEY);
      CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text);
      CREATE TABLE leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, source text, source_detail text,
        campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL, meta_lead_id text, meta_ad_id text, meta_adset_id text, meta_form_id text,
        google_lead_id text, google_campaign_id text, google_adgroup_id text, google_creative_id text, gclid text, merged_into_id uuid);`);
    await c.query('INSERT INTO tenants(id) VALUES ($1)', [T]);
    await c.query(read('models/migration_phase1_attribution.sql'));
    await c.query(read('models/migration_phase1_attribution.sql')); // idempotent
    const camp = async (name) => (await c.query('INSERT INTO campaigns(tenant_id,name) VALUES($1,$2) RETURNING id', [T, name])).rows[0].id;
    const lead = async (cols = {}) => {
      const keys = Object.keys(cols);
      const r = await c.query(`INSERT INTO leads(tenant_id${keys.map((k) => `, ${k}`).join('')}) VALUES($1${keys.map((_, i) => `, $${i + 2}`).join('')}) RETURNING id`, [T, ...keys.map((k) => cols[k])]);
      return r.rows[0].id;
    };
    const attr = async (id) => (await c.query('SELECT * FROM lead_attribution WHERE lead_id = $1', [id])).rows[0];
    const events = async (id) => (await c.query('SELECT event FROM lead_attribution_events WHERE lead_id = $1 ORDER BY created_at, id', [id])).rows.map((r) => r.event);

    const A = await camp('Campaign A'); const B = await camp('Campaign B');

    await t.test('every inserted lead is captured by the database, with the right status', async () => {
      const verified = await lead({ source: 'meta_ads', source_detail: 'Lead Ad', campaign_id: A, meta_lead_id: 'ml-1', meta_ad_id: 'ad-1', meta_adset_id: 'as-1', meta_form_id: 'f-1' });
      const a = await attr(verified);
      assert.deepEqual([a.status, a.capture_basis, a.original_crm_campaign_id, a.effective_crm_campaign_id], ['verified', 'live', A, A]);
      assert.deepEqual([a.original_source, a.original_source_detail, a.original_meta_lead_id, a.original_meta_ad_id, a.original_meta_adset_id, a.original_meta_form_id], ['meta_ads', 'Lead Ad', 'ml-1', 'ad-1', 'as-1', 'f-1']);
      assert.deepEqual(await events(verified), ['captured']);
      const google = await lead({ source: 'google_ads', google_campaign_id: 'g-1', gclid: 'x'.repeat(10) });
      assert.equal((await attr(google)).status, 'verified');
      assert.equal((await attr(await lead({ source: 'manual', campaign_id: A }))).status, 'inferred', 'a campaign with no platform evidence is inferred');
      const none = await attr(await lead({ source: 'manual' }));
      assert.deepEqual([none.status, none.effective_crm_campaign_id], ['unattributed', null]);
    });

    await t.test('a lead that arrives before its campaign completes its ORIGINAL attribution exactly once', async () => {
      const L = await lead({ source: 'meta_ads', meta_lead_id: 'ml-2', meta_form_id: 'f-2' });
      assert.equal((await attr(L)).status, 'verified');
      assert.equal((await attr(L)).original_crm_campaign_id, null);
      await c.query('UPDATE leads SET campaign_id = $2 WHERE id = $1', [L, A]);
      let a = await attr(L);
      assert.deepEqual([a.original_crm_campaign_id, a.effective_crm_campaign_id, a.status], [A, A, 'verified']);
      assert.deepEqual(await events(L), ['captured', 'completed']);
      await c.query('UPDATE leads SET campaign_id = $2 WHERE id = $1', [L, B]); // now an edit: the original stays
      a = await attr(L);
      assert.deepEqual([a.original_crm_campaign_id, a.effective_crm_campaign_id, a.status], [A, B, 'manual']);
      assert.deepEqual(await events(L), ['captured', 'completed', 'changed']);
      const e = (await c.query(`SELECT before, after FROM lead_attribution_events WHERE lead_id = $1 AND event = 'changed'`, [L])).rows[0];
      assert.deepEqual([e.before.crm_campaign_id, e.after.crm_campaign_id], [A, B]);
    });

    await t.test('the original attribution can never be rewritten, only filled once', async () => {
      const L = await lead({ source: 'meta_ads', campaign_id: A, meta_ad_id: 'ad-9' });
      await assert.rejects(c.query('UPDATE lead_attribution SET original_crm_campaign_id = $2 WHERE lead_id = $1', [L, B]), /IMMUTABLE/);
      await assert.rejects(c.query(`UPDATE lead_attribution SET original_meta_ad_id = 'other' WHERE lead_id = $1`, [L]), /IMMUTABLE: original_meta_ad_id/);
      await assert.rejects(c.query(`UPDATE lead_attribution SET lead_id = gen_random_uuid() WHERE lead_id = $1`, [L]), /IMMUTABLE|foreign key/i);
      await c.query(`UPDATE lead_attribution SET original_meta_form_id = 'late-form' WHERE lead_id = $1`, [L]); // NULL -> value is allowed once
      assert.equal((await attr(L)).original_meta_form_id, 'late-form');
      await assert.rejects(c.query(`UPDATE lead_attribution SET original_meta_form_id = 'again' WHERE lead_id = $1`, [L]), /IMMUTABLE/);
    });

    await t.test('events are append-only', async () => {
      const L = await lead({ campaign_id: A });
      await assert.rejects(c.query(`UPDATE lead_attribution_events SET reason = 'x' WHERE lead_id = $1`, [L]), /never changed/);
    });

    await t.test('an audited correction (service flag) is not logged a second time by the trigger', async () => {
      const L = await lead({ source: 'meta_ads', campaign_id: A, meta_lead_id: 'ml-3' });
      await c.query('BEGIN');
      await c.query(`SELECT set_config('curvelead.attribution_correction', 'on', true)`);
      await c.query('UPDATE leads SET campaign_id = $2 WHERE id = $1', [L, B]);
      await c.query('COMMIT');
      assert.deepEqual(await events(L), ['captured'], 'the service writes its own corrected event');
      assert.equal((await attr(L)).effective_crm_campaign_id, A, 'and sets the effective campaign itself');
    });

    await t.test('deleting a campaign keeps the original and does not turn the attribution into a manual edit', async () => {
      const gone = await camp('Doomed'); const L = await lead({ source: 'meta_ads', campaign_id: gone, meta_lead_id: 'ml-4' });
      await c.query('DELETE FROM campaigns WHERE id = $1', [gone]);
      const a = await attr(L);
      assert.equal(a.original_crm_campaign_id, gone, 'the original id survives (no foreign key)');
      assert.equal(a.effective_crm_campaign_id, null, 'the effective link is cleared by the foreign key');
      assert.equal(a.status, 'verified'); assert.deepEqual(await events(L), ['captured']);
    });

    await t.test('the migration runs twice without change and attributes only what is inserted', async () => {
      const before = (await c.query('SELECT count(*)::int n FROM lead_attribution')).rows[0].n;
      await c.query(read('models/migration_phase1_attribution.sql'));
      assert.equal((await c.query('SELECT count(*)::int n FROM lead_attribution')).rows[0].n, before);
    });

    await t.test('a database whose leads table lacks the google/meta columns still captures (columns read as NULL)', async () => {
      // a row shaped like a minimal leads table: the helper reads absent keys as NULL
      const r = await c.query(`SELECT lead_has_platform_evidence(to_jsonb(m)) AS ev FROM (SELECT gen_random_uuid() AS id, 'x'::text AS source) m`);
      assert.equal(r.rows[0].ev, false, 'missing keys read as NULL, never as an error');
      assert.equal((await c.query(`SELECT lead_has_platform_evidence('{"gclid":"abc"}'::jsonb) AS ev`)).rows[0].ev, true);
      assert.equal((await c.query(`SELECT lead_has_platform_evidence('{"gclid":"  "}'::jsonb) AS ev`)).rows[0].ev, false, 'blank evidence is not evidence');
    });
  } finally {
    await c.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
