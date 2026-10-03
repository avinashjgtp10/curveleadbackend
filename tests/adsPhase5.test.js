const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const schema = require('../services/metaAds/aiCampaignSchema');

// Phase 5: AI campaign drafts — validation rules and the paused-create / confirmed-activate flow.

const good = (over = {}) => ({
  campaign_name: 'Diwali hair spa', destination: 'LEAD_FORM', location: 'Baramati', radius_km: 25,
  age_min: 22, age_max: 45, daily_budget_inr: 500, duration_days: 14,
  primary_texts: ['Diwali glow: hair spa at ₹999 in Baramati. Book your slot this week.'], headlines: ['Hair spa ₹999'],
  descriptions: [], cta: 'BOOK_NOW', lead_form: { existing_form_id: '777' }, ...over,
});

test('a sensible draft passes; limits on text, budget, duration, radius and CTA are enforced', () => {
  assert.deepEqual(schema.validateDraft(good()).errors, []);
  const { errors, warnings } = schema.validateDraft(good({
    headlines: ['x'.repeat(41)], descriptions: ['y'.repeat(31)], primary_texts: ['z'.repeat(200)],
    daily_budget_inr: 50, duration_days: 120, radius_km: 5, cta: 'WHATSAPP_MESSAGE',
  }));
  const fields = errors.map(e => e.field);
  for (const f of ['headlines.0', 'descriptions.0', 'daily_budget_inr', 'duration_days', 'radius_km', 'cta']) assert.ok(fields.includes(f), f);
  assert.ok(warnings.some(w => w.field === 'primary_texts.0'), 'over 125 chars is a warning, not an error');
  assert.ok(schema.validateDraft(good({ primary_texts: ['a'.repeat(2201)] })).errors.some(e => e.field === 'primary_texts.0'));
});

test('banned claims are caught in English, Hindi and Marathi', () => {
  for (const text of [
    '100% guaranteed results', 'Pakki guarantee', 'Before and after photos inside', 'Permanent cure for hair fall',
    'Earn ₹50000 from home', 'घर बैठे कमाई करें', 'शत प्रतिशत परिणाम', 'आधी आणि नंतर बघा', 'Lose 10 kg in 30 days',
  ]) {
    const { errors } = schema.validateDraft(good({ primary_texts: [text] }));
    assert.ok(errors.some(e => e.field === 'copy'), text);
  }
  assert.deepEqual(schema.validateDraft(good({ primary_texts: ['Glowing skin this Diwali — book a facial at our Baramati salon.'] })).errors, []);
});

test('housing, jobs and loans get Meta special-category restrictions; home services do not', () => {
  const housing = schema.validateDraft(good({ campaign_name: '2 BHK flats', age_min: 25, age_max: 40 }), { offerText: '2 BHK flats in Baramati' });
  assert.deepEqual(housing.draft.special_ad_categories, ['HOUSING']);
  assert.equal(housing.draft.age_min, 18);
  assert.equal(housing.draft.age_max, 65);
  assert.ok(housing.warnings.some(w => w.field === 'age_min'));
  assert.deepEqual(schema.validateDraft(good(), { offerText: 'Hiring hair stylists' }).draft.special_ad_categories, ['EMPLOYMENT']);
  assert.deepEqual(schema.validateDraft(good(), { offerText: 'Easy EMI on bridal packages' }).draft.special_ad_categories, ['FINANCIAL_PRODUCTS_SERVICES']);
  assert.deepEqual(schema.validateDraft(good(), { offerText: 'Bridal makeup at ghar, home service' }).draft.special_ad_categories, []);
});

test('new lead forms need a privacy link; the daily cap is respected', () => {
  assert.ok(schema.validateDraft(good({ lead_form: { privacy_policy_url: '' } })).errors.some(e => e.field === 'lead_form.privacy_policy_url'));
  assert.deepEqual(schema.validateDraft(good({ lead_form: { privacy_policy_url: 'https://salonox.in/privacy' } })).errors, []);
  const capped = schema.validateDraft(good({ daily_budget_inr: 500 }), { capPaise: 100000, activeDailyPaise: 60000 });
  assert.ok(capped.errors.some(e => e.field === 'daily_budget_inr' && /cap/.test(e.message)));
});

// ── create / activate against a fake Meta ──────────────────────────────────
function load(file, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
    { module, exports: module.exports, console, Date, JSON, Set, Map, Promise, process: { env: {} }, setTimeout, require: k => deps[k] || {} });
  return module.exports;
}

const harness = ({ status = 'draft', metaIds = {}, failStep = null, cap = null, active = 0, scopes = ['ads_read', 'ads_management'] } = {}) => {
  const state = { row: { id: 'd1', tenant_id: 't', ad_account_id: 'acc', status, brief: { offer: 'Hair spa offer' }, edited: good(), image: { hash: 'IMGHASH' }, meta_ids: metaIds, api_log: [] } };
  const calls = [], audits = [];
  let n = 0;
  const db = { query: async (sql, p) => {
    if (sql.startsWith('UPDATE ad_ai_drafts SET status = \'creating\'')) {
      if (!['draft', 'failed'].includes(state.row.status)) return { rows: [] };
      state.row.status = 'creating'; return { rows: [{ ...state.row }] };
    }
    if (sql.startsWith('UPDATE ad_ai_drafts SET meta_ids')) {
      state.row.meta_ids = JSON.parse(p[2]); state.row.api_log = JSON.parse(p[3]);
      if (sql.includes('status =')) state.row.status = p[4];
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE ad_ai_drafts SET status = 'activated'")) { state.row.status = 'activated'; return { rows: [] }; }
    if (sql.startsWith('SELECT * FROM ad_ai_drafts')) return { rows: [{ ...state.row }] };
    if (sql.startsWith('SELECT scopes')) return { rows: [{ scopes }] };
    if (sql.startsWith('SELECT settings FROM tenants')) return { rows: [{ settings: { meta_page_id: 'PAGE', meta_page_access_token: 'ptok' } }] };
    return { rows: [] };
  } };
  const svc = load('services/metaAds/aiCampaign.js', {
    '../../config/db': db,
    '../groqService': {},
    './aiCampaignSchema': schema,
    './client': { getAccountWithToken: async () => ({ token: 'tok', account: { external_id: 'act_1', token_status: 'active', token_row_id: 'tk' } }) },
    './controls': { workspaceBudgets: async () => ({ campaigns: [], adsets: [] }), dailyBudgetTotal: () => active, budgetCap: async () => cap, audit: async (_db, row) => { audits.push(row); } },
    '../../jobs/queues': { enqueue: async () => {} },
    '../../utils/metaGraph': { graphRequest: async (opts) => {
      calls.push(opts);
      const step = opts.path;
      if (failStep && step.endsWith(failStep)) throw Object.assign(new Error('Invalid parameter'), { name: 'MetaGraphError' });
      if (step === '/search') return { data: [{ key: '1035921', name: 'Baramati', region: 'Maharashtra' }] };
      return { id: `id${++n}` };
    } },
  });
  return { svc, state, calls, audits };
};

test('creating builds campaign → ad set → creative → ad on Meta, all paused, reusing the chosen lead form', async () => {
  const { svc, state, calls, audits } = harness();
  const out = await svc.createOnMeta({ tenantId: 't', userId: 'u', id: 'd1', now: Date.parse('2026-10-03T00:00:00Z') });
  assert.equal(out.status, 'created');
  const posts = calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts.map(c => c.path), ['/act_1/campaigns', '/act_1/adsets', '/act_1/adcreatives', '/act_1/ads']);
  assert.equal(posts[0].data.status, 'PAUSED');
  assert.equal(posts[0].data.objective, 'OUTCOME_LEADS');
  assert.equal(posts[0].data.daily_budget, '50000');
  assert.equal(posts[1].data.status, 'PAUSED');
  assert.equal(posts[1].data.targeting.geo_locations.cities[0].key, '1035921');
  assert.equal(posts[1].data.end_time, '2026-10-17T00:00:00.000Z');
  assert.equal(posts[2].data.object_story_spec.link_data.call_to_action.value.lead_gen_form_id, '777');
  assert.equal(posts[2].data.object_story_spec.link_data.image_hash, 'IMGHASH');
  assert.equal(posts[3].data.status, 'PAUSED');
  assert.equal(state.row.meta_ids.form_id, '777');
  assert.equal(audits[0].action, 'create');
});

test('a failure part-way is recorded, and a retry continues without duplicating what exists', async () => {
  const first = harness({ failStep: '/adcreatives' });
  await assert.rejects(first.svc.createOnMeta({ tenantId: 't', id: 'd1' }), /Create creative: Invalid parameter/);
  assert.equal(first.state.row.status, 'failed');
  assert.ok(first.state.row.meta_ids.campaign_id && first.state.row.meta_ids.adset_id);
  assert.equal(first.state.row.api_log.at(-1).ok, false);

  const retry = harness({ status: 'failed', metaIds: first.state.row.meta_ids });
  await retry.svc.createOnMeta({ tenantId: 't', id: 'd1' });
  assert.deepEqual(retry.calls.filter(c => c.method === 'POST').map(c => c.path), ['/act_1/adcreatives', '/act_1/ads']);
});

test('nothing is created without ads_management, or twice', async () => {
  const noScope = harness({ scopes: ['ads_read'] });
  await assert.rejects(noScope.svc.createOnMeta({ tenantId: 't', id: 'd1' }), e => e.status === 403);
  assert.equal(noScope.calls.length, 0);
  const done = harness({ status: 'created' });
  await assert.rejects(done.svc.createOnMeta({ tenantId: 't', id: 'd1' }), e => e.status === 409);
});

test('activation needs the exact campaign name and room under the cap, then starts ad, ad set and campaign', async () => {
  const ids = { campaign_id: 'C', adset_id: 'S', ad_id: 'A' };
  let h = harness({ status: 'created', metaIds: ids });
  await assert.rejects(h.svc.activate({ tenantId: 't', id: 'd1', confirm: 'diwali' }), /exactly/);
  assert.equal(h.calls.length, 0);

  h = harness({ status: 'created', metaIds: ids, cap: 80000, active: 40000 });
  await assert.rejects(h.svc.activate({ tenantId: 't', id: 'd1', confirm: 'Diwali hair spa' }), /over your cap/);

  h = harness({ status: 'created', metaIds: ids });
  await h.svc.activate({ tenantId: 't', userId: 'u', id: 'd1', confirm: 'Diwali hair spa' });
  assert.deepEqual(h.calls.map(c => [c.path, c.data.status]), [['/A', 'ACTIVE'], ['/S', 'ACTIVE'], ['/C', 'ACTIVE']]);
  assert.equal(h.state.row.status, 'activated');
  assert.equal(h.audits.at(-1).action, 'activate');
});

test('lead forms always ask for name and phone', () => {
  const { svc } = harness();
  assert.deepEqual(Array.from(svc.formQuestions(['city', 'EMAIL', 'favourite colour']), q => q.type), ['FULL_NAME', 'PHONE', 'CITY', 'EMAIL']);
});
