// Batch 1 (A): the Aug2026 campaign that showed three different numbers (Campaigns card
// 4 leads / CPL ₹586, campaign detail 225 / ₹187, Meta tab 69 / ₹407) — rebuilt as a
// fixture to prove every screen now reports the same CRM numbers for the same range, with
// Meta's own count shown separately. Real PostgreSQL (production schema + migrations);
// skipped unless BATCH1_TEST_DATABASE_URL is set (see tests/batch1Sql.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.BATCH1_TEST_DATABASE_URL;
let db = null;
if (url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url });
  db = { pool, query: (t, p) => pool.query(t, p),
    transaction: async (fn) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } } };
  const p = require.resolve('../config/db');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: db };
}
const skip = !url && 'set BATCH1_TEST_DATABASE_URL to run';
const DAY = 864e5;
const TZ = 'Asia/Kolkata';
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(d) { this.data = d; return this; } });

test('Aug2026 campaign: card, detail, Meta Ads and Reports agree for the same range', { skip }, async () => {
  const t = crypto.randomUUID(), admin = crypto.randomUUID();
  await db.query(`INSERT INTO tenants (id, name, slug, email, settings) VALUES ($1,'Fixture',$2,$3,$4)`,
    [t, `fx-${t.slice(0, 8)}`, `fx-${t.slice(0, 8)}@example.test`, JSON.stringify({ timezone: TZ, country: 'IN' })]);
  try {
    await db.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_active) VALUES ($1,$2,'Admin',$3,'x','admin',true)`, [admin, t, `a-${t.slice(0, 8)}@example.test`]);
    for (const [name, pos, won, lost, qual] of [['New', 1, false, false, false], ['Qualified', 2, false, false, true], ['Won', 3, true, false, true], ['Lost', 4, false, true, false]]) {
      await db.query('INSERT INTO lead_stages (tenant_id, name, pos, is_won, is_lost, is_qualified, is_active) VALUES ($1,$2,$3,$4,$5,$6,true)', [t, name, pos, won, lost, qual]);
    }
    const campaign = (await db.query(`INSERT INTO campaigns (tenant_id, name, source, status, meta_campaign_id, actual_spend) VALUES ($1,'Salonox_LeadGen_India_Model_Aug2026','meta_ads','active','M-AUG',42135.77) RETURNING id`, [t])).rows[0].id;
    const account = (await db.query(`INSERT INTO ad_accounts (tenant_id, external_id, name, currency, timezone_name, is_primary) VALUES ($1,'act_1','Salonox','INR',$2,true) RETURNING id`, [t, TZ])).rows[0].id;
    await db.query(`INSERT INTO ad_campaigns (tenant_id, ad_account_id, external_id, campaign_id, name, status, effective_status) VALUES ($1,$2,'M-AUG',$3,'Salonox_LeadGen_India_Model_Aug2026','ACTIVE','ACTIVE')`, [t, account, campaign]);

    // Meta: 69 leads and ₹28,083 (₹407 / lead) over the last 30 days; more spend before that.
    const now = Date.now();
    for (let d = 0; d < 30; d++) {
      await db.query(`INSERT INTO ad_insights_daily (tenant_id, ad_account_id, entity_type, entity_id, date, spend, leads) VALUES ($1,$2,'campaign','M-AUG',$3,$4,$5)`,
        [t, account, ymd(new Date(now - d * DAY)), d < 29 ? 936.1 : 936.1 + 28083 - 936.1 * 30, d < 9 ? 3 : 2]);
    }
    for (let d = 30; d < 60; d++) {
      await db.query(`INSERT INTO ad_insights_daily (tenant_id, ad_account_id, entity_type, entity_id, date, spend, leads) VALUES ($1,$2,'campaign','M-AUG',$3,470,5)`, [t, account, ymd(new Date(now - d * DAY))]);
    }

    // CRM: 225 leads in total — 4 this month, more earlier in the last 30 days, the rest older.
    const monthStart = new Date(`${ymd(new Date(now)).slice(0, 8)}01T00:00:00+05:30`).getTime();
    const windowStart = new Date(`${ymd(new Date(now - 29 * DAY))}T00:00:00+05:30`).getTime();
    const room = monthStart - windowStart > 2 * DAY;            // days in the 30-day window before this month
    const created = [];
    for (let i = 0; i < 4; i++) created.push(new Date(now - (i + 1) * 60 * 1000));                              // this month
    for (let i = 0; i < 57; i++) created.push(new Date(room ? windowStart + DAY + (i / 57) * (monthStart - windowStart - 2 * DAY) : now - (i + 5) * 60 * 1000));
    for (let i = 0; i < 164; i++) created.push(new Date(windowStart - (i + 1) * 6 * 3600 * 1000));               // before the window
    const ids = [];
    for (const [i, at] of created.entries()) {
      ids.push((await db.query(`INSERT INTO leads (tenant_id, name, phone, source, stage, campaign_id, created_at, updated_at)
        VALUES ($1,$2,$3,'meta_ads','New',$4,$5,$5) RETURNING id`, [t, `Lead ${i}`, `+9198${String(76500000 + i).padStart(8, '0')}`, campaign, at])).rows[0].id);
    }
    // Wins: 3 leads from the 30-day window became customers (cohort), plus 1 older lead won
    // this month (an event that is NOT part of the cohort).
    const winsInWindow = [ids[5], ids[6], ids[7]];
    const olderWonThisMonth = ids[100];
    for (const id of [...winsInWindow, olderWonThisMonth]) {
      await db.query(`UPDATE leads SET stage = 'Won', won_at = $2 WHERE id = $1`, [id, new Date(now - 30 * 60 * 1000)]);
      await db.query(`INSERT INTO lead_stage_history (tenant_id, lead_id, prev_stage, new_stage, changed_at) VALUES ($1,$2,'New','Won',$3)`, [t, id, new Date(now - 30 * 60 * 1000)]);
    }

    const req = (query = {}, params = {}) => ({ tenantId: t, user: { id: admin, role: 'admin' }, query, params, body: {} });
    const camp = require('../controllers/campaignController');
    const ads = require('../controllers/adsController');
    const reports = require('../controllers/reportsController');

    // ── the same range everywhere: last 30 days ──
    const card = res(); await camp.getCampaigns(req({ period: 'last_30_days' }), card);
    const detail = res(); await camp.getCampaign(req({ period: 'last_30_days' }, { id: campaign }), detail);
    const report = res(); await reports.getReportByCampaign(req({ period: 'last_30_days' }), report);
    const meta = res(); await ads.dashboard(req({ from: ymd(new Date(now - 29 * DAY)), to: ymd(new Date(now)) }), meta);
    for (const r of [card, detail, report, meta]) assert.equal(r.code, 200, JSON.stringify(r.data));

    const c = card.data.campaigns.find(x => x.id === campaign);
    const d = detail.data.campaign;
    const rp = report.data.campaigns.find(x => x.id === campaign);
    const m = meta.data.campaigns.find(x => x.crm_campaign_id === campaign);

    const expectLeads = created.filter(at => at.getTime() >= windowStart).length;   // 61
    assert.equal(expectLeads, 61);
    for (const [screen, leads] of [['card', c.crm_leads], ['detail', d.crm_leads], ['reports', rp.crm_leads], ['meta tab', m.crm_leads]]) {
      assert.equal(leads, expectLeads, `${screen}: leads in CurveLead`);
    }
    for (const [screen, spend] of [['card', c.spend], ['detail', d.spend], ['reports', rp.spend], ['meta tab', m.spend]]) {
      assert.equal(Math.round(spend), 28083, `${screen}: spend in range`);
    }
    for (const [screen, cpl] of [['card', c.cpl], ['detail', d.cpl], ['reports', rp.cpl], ['meta tab', m.cost_per_lead]]) {
      assert.equal(Math.round(cpl), Math.round(28083 / 61), `${screen}: CPL = spend ÷ leads in CurveLead`);
    }
    for (const [screen, conv] of [['card', c.converted], ['detail', d.converted], ['reports', rp.converted], ['meta tab', m.converted_leads]]) {
      assert.equal(conv, 3, `${screen}: converted (cohort)`);
    }
    // Meta's own count is reported separately and labelled as such.
    assert.equal(c.platform_leads, 69); assert.equal(m.meta_leads, 69); assert.equal(Math.round(m.meta_cpl), 407);
    // Won this period (event) includes the older lead won this month; the cohort doesn't.
    assert.equal(c.won, 4); assert.equal(rp.won, 4); assert.equal(m.won_this_period, 4);
    // Cost per customer is cohort-based.
    assert.equal(Math.round(c.cost_per_customer), Math.round(28083 / 3));

    // ── other ranges: the numbers people saw before, now consistent per range ──
    const lifetime = res(); await camp.getCampaign(req({ period: 'lifetime' }, { id: campaign }), lifetime);
    assert.equal(lifetime.data.campaign.crm_leads, 225);
    const month = res(); await camp.getCampaigns(req({ period: 'this_month' }), month);
    assert.equal(month.data.campaigns.find(x => x.id === campaign).crm_leads, room ? 4 : 61);

    // KPIs count campaign-attributed leads only, and the verdict's "your avg" is the KPI rate.
    await db.query(`INSERT INTO leads (tenant_id, name, phone, source, stage, created_at) VALUES ($1,'Walk-in','+919812345678','walkin','New',now())`, [t]);
    const again = res(); await camp.getCampaigns(req({ period: 'last_30_days' }), again);
    assert.equal(again.data.metrics.crm_leads, expectLeads, 'unattributed leads are not in the Campaigns KPIs');
    assert.equal(again.data.metrics.conversion_rate, Number((3 / 61 * 100).toFixed(1)));
    const row = again.data.campaigns.find(x => x.id === campaign);
    if (/your avg is/.test(row.verdict_reason || '')) assert.match(row.verdict_reason, new RegExp(`your avg is ${again.data.metrics.conversion_rate.toFixed(1)}%`));
  } finally {
    await db.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
});

test('one definition of won: a stage flagged is_won counts, whatever it is called', { skip }, async () => {
  const t = crypto.randomUUID(), admin = crypto.randomUUID();
  await db.query(`INSERT INTO tenants (id, name, slug, email, settings) VALUES ($1,'Converted ws',$2,$3,'{}')`, [t, `cw-${t.slice(0, 8)}`, `cw-${t.slice(0, 8)}@example.test`]);
  try {
    await db.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, is_active) VALUES ($1,$2,'Admin',$3,'x','admin',true)`, [admin, t, `c-${t.slice(0, 8)}@example.test`]);
    await db.query(`INSERT INTO lead_stages (tenant_id, name, pos, is_won, is_lost, is_active) VALUES ($1,'New Lead',1,false,false,true),($1,'Converted',2,true,false,true)`, [t]);
    const l = (await db.query(`INSERT INTO leads (tenant_id, name, phone, source, stage, won_at, created_at) VALUES ($1,'A','+919811111111','manual','Converted',now(),now()) RETURNING id`, [t])).rows[0].id;
    const metrics = require('../services/metrics');
    const scope = await metrics.metricScope({ tenantId: t, user: { role: 'admin' }, query: { period: 'this_month' } });
    const m = await metrics.getMetrics(scope);
    assert.equal(m.won, 1); assert.equal(m.converted, 1);
    assert.ok(l);
    // Accepting a quotation moves the lead to THIS workspace's won stage, not a literal "Won".
    const { wonStageName } = require('../utils/leadStage');
    assert.equal(await wonStageName(t), 'Converted');
  } finally {
    await db.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
});

test.after(async () => { if (db) await db.pool.end(); });
