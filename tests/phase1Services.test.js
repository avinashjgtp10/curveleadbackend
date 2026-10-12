// Attribution + booking services, the advance migration and attribution backfill scripts (control flow with fakes),
// and the static guarantees of the three new migrations. The SQL itself runs on PostgreSQL in tests/phase1*Sql.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const code = (f) => read(f).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

const loadWith = (file, mocks) => {
  const saved = {}; const paths = Object.keys(mocks).map((k) => [k, require.resolve(k)]);
  for (const [k, p] of paths) { saved[p] = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports: mocks[k] }; }
  const f = require.resolve(file); delete require.cache[f];
  try { return require(f); } finally { delete require.cache[f]; for (const [, p] of paths) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } }
};
const T = '11111111-1111-1111-1111-111111111111', L = '22222222-2222-2222-2222-222222222222', U = '33333333-3333-3333-3333-333333333333', C = '44444444-4444-4444-4444-444444444444';

// ---- attribution service ----------------------------------------------------------------------------------------------------------------------
const attrDb = ({ table = true, lead = { id: L, campaign_id: null, merged_into_id: null }, campaign = true, existing = { effective_crm_campaign_id: null, status: 'unattributed' } } = {}) => {
  const log = []; let txns = 0; let rolled = 0;
  const run = async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ').trim(); log.push({ sql, p });
    if (/to_regclass\('lead_attribution'\)/.test(sql)) return { rows: [{ present: table }] };
    if (/FROM leads WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/.test(sql)) return { rows: lead ? [lead] : [] };
    if (/FROM campaigns WHERE id = \$1 AND tenant_id = \$2/.test(sql)) return { rows: campaign ? [{ '?column?': 1 }] : [] };
    if (/^INSERT INTO lead_attribution \(lead_id/.test(sql)) { existing = { effective_crm_campaign_id: null, status: 'unattributed' }; return { rows: [] }; }
    if (/^SELECT \* FROM lead_attribution WHERE lead_id = \$1/.test(sql)) return { rows: existing ? [existing] : [] };
    if (/^SELECT status, effective_crm_campaign_id, corrected_at/.test(sql)) return { rows: [{ status: 'manual', effective_crm_campaign_id: C, corrected_at: 'now', correction_reason: 'why' }] };
    return { rows: [] };
  };
  return { log, query: run, transaction: async (fn) => { txns++; try { return await fn({ query: run }); } catch (e) { rolled++; throw e; } }, stats: () => ({ txns, rolled }) };
};
const attr = (db) => loadWith('../services/attribution', { '../config/db': db });

test('a correction needs a reason, an existing campaign, and an unmerged lead', async () => {
  const bad = async (db, args, code) => assert.rejects(attr(db).correct({ tenantId: T, leadId: L, userId: U, crmCampaignId: C, reason: 'Wrong campaign recorded', ...args }), (e) => e.code === code, code);
  await bad(attrDb(), { reason: '  ' }, 'reason_required');
  await bad(attrDb(), { reason: 'ab' }, 'reason_required');
  await bad(attrDb({ campaign: false }), {}, 'campaign_not_found');
  await bad(attrDb({ lead: null }), {}, 'lead_not_found');
  await bad(attrDb({ lead: { id: L, campaign_id: null, merged_into_id: C } }), {}, 'lead_merged');
  await bad(attrDb({ table: false }), {}, 'attribution_unavailable');
});

test('a correction sets the flag first, changes only the EFFECTIVE campaign, logs one event, and keeps leads.campaign_id in step, in one transaction', async () => {
  const db = attrDb(); const out = await attr(db).correct({ tenantId: T, leadId: L, userId: U, crmCampaignId: C, reason: 'Came from the Diwali ad' });
  const sqls = db.log.map((l) => l.sql);
  const flag = sqls.findIndex((s) => /set_config\('curvelead\.attribution_correction', 'on', true\)/.test(s));
  const upd = sqls.findIndex((s) => /^UPDATE lead_attribution SET effective_crm_campaign_id/.test(s));
  const ev = sqls.findIndex((s) => /INSERT INTO lead_attribution_events/.test(s) && /'corrected'/.test(s));
  const legacy = sqls.findIndex((s) => /^UPDATE leads SET campaign_id = \$2 WHERE id = \$1/.test(s));
  assert.ok(flag >= 0 && flag < upd && upd < ev && ev < legacy, 'order: flag, attribution, event, legacy field');
  assert.ok(!sqls.some((s) => /original_/.test(s) && /^UPDATE/.test(s)), 'the original is never touched');
  assert.match(sqls[upd], /status = 'manual'/);
  assert.equal(db.stats().txns, 1); assert.equal(out.status, 'manual');
});

test('correcting a lead with no attribution record creates one (backfill-labelled) before correcting it', async () => {
  const db = attrDb({ existing: null, lead: { id: L, campaign_id: C, merged_into_id: null } });
  await attr(db).correct({ tenantId: T, leadId: L, userId: U, crmCampaignId: null, reason: 'Not from any ad' });
  assert.ok(db.log.some((l) => /^INSERT INTO lead_attribution \(lead_id/.test(l.sql) && /'backfill'/.test(l.sql)));
  assert.ok(db.log.some((l) => /^UPDATE leads SET campaign_id = \$2 WHERE id = \$1/.test(l.sql) && l.p[1] === null), 'null clears the campaign');
});

// ---- booking service ---------------------------------------------------------------------------------------------------------------------------
const bookDb = ({ view = true, current = { value: '20000.00', currency: 'INR' }, won = true, dup = false, lead = { id: L, merged_into_id: null } } = {}) => {
  const log = [];
  const run = async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ').trim(); log.push({ sql, p });
    if (/to_regclass\('v_lead_booked'\)/.test(sql)) return { rows: [{ present: view }] };
    if (/FROM leads WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/.test(sql)) return { rows: lead ? [lead] : [] };
    if (/^SELECT value, currency FROM v_lead_booked/.test(sql)) return { rows: current ? [current] : [] };
    if (/FROM lead_milestone_events/.test(sql)) return { rows: won ? [{ x: 1 }] : [] };
    if (/created_at > now\(\) - interval '5 seconds'/.test(sql)) return { rows: dup ? [{ id: 'a' }] : [] };
    if (/^SELECT value, currency, booked_basis, adjusted FROM v_lead_booked/.test(sql)) return { rows: [{ value: '18000.00', currency: 'INR', booked_basis: 'live_snapshot', adjusted: true }] };
    if (/FROM booking_adjustments WHERE lead_id/.test(sql)) return { rows: [{ new_value: '18000', new_currency: null, reason: 'agreed discount', evidence_ref: 'INV-7', created_at: 'now' }] };
    return { rows: [] };
  };
  return { log, query: run, transaction: async (fn) => fn({ query: run }) };
};
const booking = (db) => loadWith('../services/finance/booking', { '../config/db': db });

test('a booking adjustment needs a reason and a valid value, and only a booked / Won lead can be adjusted', async () => {
  const base = { tenantId: T, leadId: L, userId: U, value: 18000, reason: 'Agreed discount' };
  await assert.rejects(booking(bookDb()).adjust({ ...base, reason: '' }), (e) => e.code === 'reason_required');
  for (const value of [-1, 'abc', 1e12, null, []]) await assert.rejects(booking(bookDb()).adjust({ ...base, value }), (e) => e.code === 'invalid_amount', String(value));
  await assert.rejects(booking(bookDb()).adjust({ ...base, currency: 'rupees' }), (e) => e.code === 'invalid_currency');
  await assert.rejects(booking(bookDb({ current: null, won: false })).adjust(base), (e) => e.code === 'not_booked');
  await assert.rejects(booking(bookDb({ lead: { id: L, merged_into_id: C } })).adjust(base), (e) => e.code === 'lead_merged');
  await assert.rejects(booking(bookDb({ view: false })).adjust(base), (e) => e.code === 'booking_unavailable');
});

test('an adjustment records previous and new value plus an audit entry; a double-click within seconds is a replay', async () => {
  const db = bookDb(); const out = await booking(db).adjust({ tenantId: T, leadId: L, userId: U, value: '18000', currency: 'inr', reason: 'Agreed discount', evidenceRef: 'INV-7' });
  const ins = db.log.find((l) => /^INSERT INTO booking_adjustments/.test(l.sql));
  assert.deepEqual([ins.p[2], ins.p[3], ins.p[4], ins.p[5], ins.p[6]], [20000, 18000, 'INR', 'Agreed discount', 'INV-7']);
  assert.ok(db.log.some((l) => /^INSERT INTO financial_audit_log/.test(l.sql) && /booked_value_adjusted/.test(l.sql)));
  assert.equal(out.replayed, false); assert.equal(out.booked.value, 18000);
  const again = bookDb({ dup: true }); const r2 = await booking(again).adjust({ tenantId: T, leadId: L, userId: U, value: 18000, reason: 'Agreed discount' });
  assert.equal(r2.replayed, true); assert.ok(!again.log.some((l) => /^INSERT INTO booking_adjustments/.test(l.sql)));
});

test('getBooked is null before the booking migration is installed', async () => {
  assert.equal(await booking(bookDb({ view: false })).getBooked({ tenantId: T, leadId: L }), null);
});

// ---- scripts --------------------------------------------------------------------------------------------------------------------------------------
const advFake = ({ leads, absorbed = [], ledger = true, tenant = { id: T, name: 'Salonox', settings: { currency: 'INR' } } }) => {
  const log = []; const inserted = [];
  return { log, inserted, query: async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ').trim(); log.push(sql.slice(0, 40));
    if (/to_regclass\('lead_payments'\)/.test(sql)) return { rows: [{ ok: ledger }] };
    if (/^SELECT id, name, settings FROM tenants/.test(sql)) return { rows: tenant ? [tenant] : [] };
    if (/merged_into_id IS NOT NULL AND COALESCE\(advance_received/.test(sql)) return { rows: absorbed };
    if (/ORDER BY l\.id LIMIT/.test(sql)) { const [, cursor, size] = p; return { rows: leads.filter((l) => cursor === null || l.id > cursor).slice(0, size) }; }
    if (/^INSERT INTO lead_payments/.test(sql)) { const key = p[6]; if (inserted.some((i) => i.key === key)) return { rowCount: 0 }; inserted.push({ key, lead: p[1], amount: p[2], currency: p[3], estimated: p[4], notes: p[5] }); return { rowCount: 1 }; }
    return { rows: [] };
  } };
};
const mk = (n, over = {}) => ({ id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, advance_received: '5000.00', won_at: '2026-09-01', won_on: '2026-09-01', has_ledger: false, in_won_stage: true, ...over });
const adv = require('../scripts/migrateAdvancePayments');

test('advance migration: dry run writes nothing; apply writes one UNKNOWN-date completed payment per lead with a deterministic key', async () => {
  const leads = [mk(1), mk(2, { in_won_stage: false, advance_received: '1000' }), mk(3, { has_ledger: true }), mk(4, { won_on: null })];
  const dry = advFake({ leads });
  const r0 = await adv.run({ client: dry, tenantId: T, batch: 2 });
  assert.deepEqual([r0.mode, r0.would_migrate, r0.migrated, r0.skipped_has_ledger_rows, r0.not_won_anomalies], ['DRY-RUN', 3, 0, 1, 1]);
  assert.ok(!dry.log.some((l) => /^(BEGIN|INSERT)/.test(l)));
  const db = advFake({ leads }); const r = await adv.run({ client: db, tenantId: T, apply: true, batch: 2 });
  assert.deepEqual([r.migrated, r.total_amount, r.batches], [3, 11000, 2]);
  assert.deepEqual(db.inserted.map((i) => i.key), leads.filter((l) => !l.has_ledger).map((l) => adv.KEY(l.id)));
  assert.equal(db.inserted[0].estimated, '2026-09-01'); assert.equal(db.inserted[2].estimated, null);
  assert.match(db.inserted[1].notes, /Anomaly: the lead was not in a Won stage/);
  const again = await adv.run({ client: db, tenantId: T, apply: true, batch: 2 });
  assert.equal(again.migrated, 0, 'a rerun inserts nothing (deterministic keys)'); assert.equal(db.inserted.length, 3);
});

test('advance migration: absorbed leads are listed for review and never migrated; bad input and a missing ledger are refused', async () => {
  const db = advFake({ leads: [mk(1)], absorbed: [{ id: 'm1', merged_into_id: 'k1', advance_received: '700' }, { id: 'm2', merged_into_id: 'k2', advance_received: '300.50' }] });
  const r = await adv.run({ client: db, tenantId: T, apply: true });
  assert.deepEqual([r.absorbed_review.leads, r.absorbed_review.total_amount], [2, 1000.5]);
  assert.ok(!db.inserted.some((i) => ['m1', 'm2'].includes(i.lead)));
  await assert.rejects(adv.run({ client: advFake({ leads: [] }), tenantId: 'nope' }), /workspace uuid/);
  await assert.rejects(adv.run({ client: advFake({ leads: [], ledger: false }), tenantId: T }), /ledger is not installed/);
  await assert.rejects(adv.run({ client: advFake({ leads: [], tenant: null }), tenantId: T }), /No such workspace/);
  await assert.rejects(adv.run({ client: advFake({ leads: [] }), tenantId: T, batch: 0 }), /batch must be/);
  assert.equal((await adv.run({ client: advFake({ leads: [mk(1)], tenant: { id: T, name: 'x', settings: { currency: 'usd' } } }), tenantId: T })).currency, 'INR', 'an invalid stored currency falls back to the default');
});

test('advance migration cannot stop early whatever the batch size', async () => {
  const leads = Array.from({ length: 9 }, (_, i) => mk(i + 1));
  for (const batch of [1, 2, 4, 100]) assert.equal((await adv.run({ client: advFake({ leads }), tenantId: T, apply: true, batch })).migrated, 9, `batch=${batch}`);
});

const back = require('../scripts/backfillAttribution');
const backFake = ({ leads, installed = true }) => {
  const log = []; let created = 0;
  return { log, created: () => created, query: async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ').trim(); log.push(sql.slice(0, 40));
    if (/to_regclass\('lead_attribution'\)/.test(sql)) return { rows: [{ ok: installed }] };
    if (/lead_has_platform_evidence\(to_jsonb\(l\)\) THEN 'verified' WHEN l\.campaign_id IS NOT NULL THEN 'inferred' ELSE 'unattributed' END AS status/.test(sql)) {
      const [, cursor, size] = p; return { rows: leads.filter((l) => cursor === null || l.id > cursor).slice(0, size) };
    }
    if (/^INSERT INTO lead_attribution \(lead_id/.test(sql)) { created += p[0].length; return { rowCount: p[0].length }; }
    return { rows: [], rowCount: 0 };
  } };
};
const lead = (n, status) => ({ id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, status });

test('attribution backfill: dry run counts by status and writes nothing; apply needs a workspace and fills in batches', async () => {
  const leads = [lead(1, 'verified'), lead(2, 'inferred'), lead(3, 'unattributed'), lead(4, 'verified'), lead(5, 'unattributed')];
  const dry = backFake({ leads }); const r0 = await back.run({ client: dry, batch: 2 });
  assert.deepEqual([r0.mode, r0.scanned, r0.by_status, r0.created], ['DRY-RUN', 5, { verified: 2, inferred: 1, unattributed: 2 }, 0]);
  assert.ok(!dry.log.some((l) => /^(BEGIN|INSERT)/.test(l)));
  await assert.rejects(back.run({ client: backFake({ leads }), apply: true }), /without --tenant/);
  const db = backFake({ leads }); const r = await back.run({ client: db, tenantId: T, apply: true, batch: 2 });
  assert.deepEqual([r.created, r.batches], [5, 3]); assert.equal(db.created(), 5);
  await assert.rejects(back.run({ client: backFake({ leads, installed: false }), tenantId: T }), /not installed/);
  await assert.rejects(back.run({ client: backFake({ leads }), tenantId: 'bad' }), /workspace uuid/);
});

test('attribution backfill is insert-only and never rewrites an existing record', () => {
  const src = read('scripts/backfillAttribution.js').replace(/\/\/.*$/gm, '');
  assert.match(src, /ON CONFLICT \(lead_id\) DO NOTHING/);
  assert.match(src, /NOT EXISTS \(SELECT 1 FROM lead_attribution a WHERE a\.lead_id/);
  assert.doesNotMatch(src, /\b(UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
});

// ---- migrations (static) ---------------------------------------------------------------------------------------------------------------------------
test('attribution migration: no error handling (a failure rolls the lead write back), original immutable, events append-only, capture on insert', () => {
  const c = code('models/migration_phase1_attribution.sql');
  assert.doesNotMatch(c, /\bEXCEPTION\s+WHEN\b/i); assert.doesNotMatch(c, /WHEN OTHERS/i);
  assert.match(c, /original\\_%/); assert.match(c, /IMMUTABLE/); assert.match(c, /lead_attribution_events_immutable/);
  assert.match(c, /CREATE TRIGGER lead_attribution_capture AFTER INSERT ON leads/);
  assert.match(c, /WHEN \(OLD\.campaign_id IS DISTINCT FROM NEW\.campaign_id\)/);
  assert.match(c, /to_jsonb\(NEW\)/, 'columns are read through jsonb so absent columns read as NULL');
  assert.doesNotMatch(c, /original_crm_campaign_id\s+uuid\s+REFERENCES/, 'the original campaign id has no foreign key, so it survives a campaign deletion');
  assert.doesNotMatch(c, /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM)\b/i);
});

test('booking migration: only nullable added columns, append-only adjustments with a mandatory reason, snapshot only for counted Won events', () => {
  const c = code('models/migration_phase1_booking.sql');
  assert.deepEqual([...c.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => `${m[1]}.${m[2]}`), ['leads.booked_value', 'leads.booked_currency', 'leads.booked_at', 'leads.booked_basis', 'leads.booked_source']);
  assert.doesNotMatch(c, /ADD COLUMN[^;]*NOT NULL/i);
  assert.match(c, /reason\s+text NOT NULL CHECK \(btrim\(reason\) <> ''\)/); assert.match(c, /booking_adjustments_immutable BEFORE UPDATE OR DELETE/);
  assert.match(c, /WHEN \(NEW\.milestone = 'won' AND NOT NEW\.suppressed\)/);
  assert.doesNotMatch(c, /\bEXCEPTION\s+WHEN\b/i);
});

test('merges keep attribution, bookings and their trail with the original lead and record what was merged in', () => {
  const m = read('services/leadMerge.js');
  assert.match(m, /'lead_attribution', 'lead_attribution_events', 'booking_adjustments'\)/);
  assert.match(m, /'merged_in'/); assert.match(m, /inherited_from_merge/); assert.match(m, /merge_booking_conflict/);
});

test('every Phase 1 SQL test is picked up by the harness', () => {
  const files = require('../scripts/runPhase1SqlTests').testFiles();
  for (const f of ['Milestones', 'Ledger', 'Attribution', 'Booking']) assert.ok(files.includes(`tests/phase1${f}Sql.test.js`), f);
});

test('the quotation accept sets the quote BEFORE moving the lead to Won, so the booking snapshot captures it', () => {
  const src = read('controllers/quotationsController.js');
  assert.ok(src.indexOf('UPDATE leads SET deal_value') < src.indexOf('await changeLeadStage('));
});
