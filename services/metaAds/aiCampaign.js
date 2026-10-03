const { query } = require('../../config/db');
const { graphRequest } = require('../../utils/metaGraph');
const { callGroq } = require('../groqService');
const { getAccountWithToken } = require('./client');
const { validateDraft, LANGUAGES, CTAS } = require('./aiCampaignSchema');
const controls = require('./controls');
const queues = require('../../jobs/queues');

// Phase 5: AI-drafted Meta lead campaigns. Draft (Groq) → review/edit (re-validated) →
// create on Meta, everything PAUSED → activate as a separate, confirmed step.

const fail = (status, message) => Object.assign(new Error(message), { status });
const LANG_NAMES = { en: 'English', hi: 'Hindi (Devanagari script)', mr: 'Marathi (Devanagari script)' };
const DAY_MS = 864e5;

// ── context ────────────────────────────────────────────────────────────────
const primaryAccount = async (tenantId) => {
  const { rows } = await query(
    `SELECT a.id FROM ad_accounts a JOIN ad_oauth_tokens t ON t.id = a.token_id AND t.tenant_id = a.tenant_id AND t.status = 'active'
     WHERE a.tenant_id = $1 AND a.provider = 'meta' AND a.is_active ORDER BY a.is_primary DESC, a.created_at LIMIT 1`, [tenantId]
  );
  if (!rows[0]) throw fail(400, 'Connect a Meta ad account in Ads Manager → Meta Ads first.');
  return rows[0].id;
};

// The workspace's best ads by cost per lead (≥ 10 leads, last 90 days) — shown to the model.
const topAds = async (tenantId) => (await query(
  `SELECT ad.name, ad.creative->>'title' AS title, ad.creative->>'body' AS body,
          sum(i.leads)::int AS leads, round(sum(i.spend) / NULLIF(sum(i.leads), 0), 2)::float AS cpl
   FROM ad_insights_daily i JOIN ad_ads ad ON ad.tenant_id = i.tenant_id AND ad.external_id = i.entity_id
   WHERE i.tenant_id = $1 AND i.entity_type = 'ad' AND i.date >= current_date - 90
   GROUP BY ad.id HAVING sum(i.leads) >= 10 ORDER BY cpl ASC NULLS LAST LIMIT 5`, [tenantId]
)).rows;

const budgetContext = async (tenantId) => {
  const { campaigns, adsets } = await controls.workspaceBudgets(tenantId);
  return { capPaise: await controls.budgetCap(tenantId), activeDailyPaise: controls.dailyBudgetTotal(campaigns, adsets) };
};

// ── brief → draft ──────────────────────────────────────────────────────────
const validateBrief = (b = {}) => {
  const brief = {
    offer: String(b.offer || '').trim().slice(0, 600),
    location: String(b.location || '').trim().slice(0, 80),
    budget_per_day_inr: Math.round(Number(b.budget_per_day_inr)),
    duration_days: Math.round(Number(b.duration_days)),
    goal: String(b.goal || '').trim().slice(0, 300),
    language: LANGUAGES.includes(b.language) ? b.language : 'en',
    destination: CTAS[b.destination] ? b.destination : 'LEAD_FORM',
  };
  if (brief.offer.length < 10) throw fail(422, 'Describe the offer in a sentence or two.');
  if (!brief.location) throw fail(422, 'Say which city to advertise in.');
  if (!(brief.budget_per_day_inr >= 100)) throw fail(422, 'Daily budget must be at least ₹100.');
  if (!(brief.duration_days >= 1 && brief.duration_days <= 90)) throw fail(422, 'Duration must be 1–90 days.');
  return brief;
};

const buildMessages = ({ brief, businessName, businessDescription, top }) => [
  {
    role: 'system',
    content: `You write Meta (Facebook/Instagram) lead-generation ads for small Indian businesses. Reply with JSON only.
Rules: write ad copy in ${LANG_NAMES[brief.language]}. Primary texts: 3–5 variants, ideally under 125 characters, max 2 200. Headlines: 3–5, max 40 characters. Descriptions: 0–3, max 30 characters.
Never promise guaranteed or 100% results, before/after transformations, cures, miracle or permanent health results, or income. No ALL CAPS. Be specific about the offer, the place and a clear next step.
JSON shape: {"campaign_name": string (short, English), "primary_texts": string[], "headlines": string[], "descriptions": string[], "ctas": string[] (from ${CTAS[brief.destination].join(', ')}), "radius_km": number 17-80, "age_min": number, "age_max": number, "lead_form_questions": string[] (from FULL_NAME, PHONE, EMAIL, CITY), "reasoning": string (one sentence, English)}`,
  },
  {
    role: 'user',
    content: JSON.stringify({
      business: businessName, about: businessDescription || undefined,
      offer: brief.offer, goal: brief.goal || undefined, city: brief.location,
      daily_budget_inr: brief.budget_per_day_inr, duration_days: brief.duration_days,
      destination: brief.destination === 'WHATSAPP' ? 'Click-to-WhatsApp chat' : 'Instant lead form',
      best_past_ads: top.length ? top : undefined,
    }),
  },
];

const draftRow = (r, warnings = []) => r && ({
  id: r.id, status: r.status, brief: r.brief, draft: r.edited, ai_reasoning: r.ai_output?.reasoning || null,
  errors: r.validation_errors || [], warnings, image: r.image, meta_ids: r.meta_ids, api_log: r.api_log,
  error: r.error, created_at: r.created_at, updated_at: r.updated_at,
});

const generateDraft = async ({ tenantId, userId, brief: rawBrief }) => {
  const brief = validateBrief(rawBrief);
  const adAccountId = await primaryAccount(tenantId);
  const tenant = (await query('SELECT name, settings FROM tenants WHERE id = $1', [tenantId])).rows[0] || {};
  const settings = tenant.settings || {};

  const result = await callGroq(buildMessages({ brief, businessName: tenant.name, businessDescription: settings.business_description, top: await topAds(tenantId) }),
    { json: true, temperature: 0.6, maxTokens: 1800 });
  let ai;
  try { ai = JSON.parse(result.content); } catch { throw fail(502, 'The AI returned an unusable draft. Please try again.'); }
  if (!Array.isArray(ai.primary_texts) || !ai.primary_texts.length) throw fail(502, 'The AI did not return any ad copy. Check that AI is configured, then try again.');

  const candidate = {
    campaign_name: ai.campaign_name || `${brief.offer.slice(0, 40)} — ${brief.location}`,
    destination: brief.destination, location: brief.location, radius_km: ai.radius_km || 25,
    age_min: ai.age_min, age_max: ai.age_max,
    daily_budget_inr: brief.budget_per_day_inr, duration_days: brief.duration_days,
    primary_texts: ai.primary_texts, headlines: ai.headlines, descriptions: ai.descriptions, ctas: ai.ctas,
    cta: (ai.ctas || []).find(c => CTAS[brief.destination].includes(String(c).toUpperCase())) || CTAS[brief.destination][0],
    lead_form: { questions: ai.lead_form_questions, privacy_policy_url: settings.ads_privacy_policy_url || '' },
  };
  const { errors, warnings, draft } = validateDraft(candidate, { offerText: brief.offer, ...await budgetContext(tenantId) });
  const { rows } = await query(
    `INSERT INTO ad_ai_drafts (tenant_id, user_id, ad_account_id, brief, ai_output, edited, validation_errors)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenantId, userId, adAccountId, JSON.stringify(brief), JSON.stringify(ai), JSON.stringify(draft), JSON.stringify(errors)]
  );
  return draftRow(rows[0], warnings);
};

const getDraft = async (tenantId, id) => {
  const { rows } = await query('SELECT * FROM ad_ai_drafts WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (!rows[0]) throw fail(404, 'Draft not found.');
  return rows[0];
};

const listDrafts = async (tenantId) => (await query(
  `SELECT id, status, brief, edited, validation_errors, meta_ids, error, created_at, updated_at
   FROM ad_ai_drafts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 30`, [tenantId]
)).rows.map(r => ({ id: r.id, status: r.status, campaign_name: r.edited?.campaign_name, brief: r.brief,
  daily_budget_inr: r.edited?.daily_budget_inr, error_count: (r.validation_errors || []).length, meta_ids: r.meta_ids, error: r.error, created_at: r.created_at }));

const updateDraft = async ({ tenantId, id, draft }) => {
  const row = await getDraft(tenantId, id);
  if (!['draft', 'failed'].includes(row.status)) throw fail(409, 'This campaign is already on Meta and can no longer be edited here.');
  const { errors, warnings, draft: clean } = validateDraft(draft, { offerText: row.brief?.offer, ...await budgetContext(tenantId) });
  const { rows } = await query(
    'UPDATE ad_ai_drafts SET edited = $3, validation_errors = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [tenantId, id, JSON.stringify(clean), JSON.stringify(errors)]
  );
  if (clean.lead_form.privacy_policy_url) {
    await query(`UPDATE tenants SET settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('ads_privacy_policy_url', $2::text) WHERE id = $1`, [tenantId, clean.lead_form.privacy_policy_url]);
  }
  return draftRow(rows[0], warnings);
};

// ── Meta access ────────────────────────────────────────────────────────────
const metaAccess = async (tenantId, adAccountId) => {
  const found = await getAccountWithToken(tenantId, adAccountId);
  if (!found?.token || found.account.token_status !== 'active') throw fail(400, 'Facebook access has expired — click Reconnect in Ads Manager → Meta Ads.');
  const scopes = (await query('SELECT scopes FROM ad_oauth_tokens WHERE tenant_id = $1 AND id = $2', [tenantId, found.account.token_row_id])).rows[0]?.scopes || [];
  if (!scopes.includes('ads_management')) throw fail(403, 'CurveLead can only read these ads. Click Reconnect in Ads Manager → Meta Ads and allow "Manage your ads".');
  const settings = (await query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]?.settings || {};
  if (!settings.meta_page_id || !settings.meta_page_access_token) throw fail(400, 'Connect your Facebook Page in Integrations — ads run from your Page.');
  return { token: found.token, act: found.account.external_id, pageId: String(settings.meta_page_id), pageToken: settings.meta_page_access_token };
};

// POST /api/ads/ai/drafts/:id/image — the ad image goes straight into the ad account's library.
const uploadImage = async ({ tenantId, id, file }) => {
  const row = await getDraft(tenantId, id);
  if (!['draft', 'failed'].includes(row.status)) throw fail(409, 'This campaign is already on Meta.');
  if (!file || !/^image\/(jpeg|png)$/.test(file.mimetype)) throw fail(422, 'Upload a JPG or PNG image.');
  const { token, act } = await metaAccess(tenantId, row.ad_account_id);
  const res = await graphRequest({ path: `/${act}/adimages`, method: 'POST', token, gateKey: act, data: { bytes: file.buffer.toString('base64') }, retries: 2 });
  const img = Object.values(res.images || {})[0];
  if (!img?.hash) throw fail(502, 'Meta did not accept the image.');
  const image = { hash: img.hash, url: img.url || null, name: file.originalname || 'image' };
  await query('UPDATE ad_ai_drafts SET image = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId, id, JSON.stringify(image)]);
  return image;
};

// ── create (paused) ────────────────────────────────────────────────────────
const QUESTION_TYPES = ['FULL_NAME', 'PHONE', 'EMAIL', 'CITY'];
const formQuestions = (qs) => {
  const types = (qs || []).map(q => String(q).toUpperCase().replace(/\s+/g, '_')).filter(t => QUESTION_TYPES.includes(t));
  return [...new Set(['FULL_NAME', 'PHONE', ...types])].map(type => ({ type }));
};

const linkDataFor = (d, image, formId) => ({
  message: d.primary_texts[d.primary_text_index] || d.primary_texts[0],
  name: d.headlines[d.headline_index] || d.headlines[0],
  ...(d.descriptions[0] ? { description: d.descriptions[0] } : {}),
  image_hash: image.hash,
  ...(d.destination === 'WHATSAPP'
    ? { link: 'https://api.whatsapp.com/send', call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } }
    : { link: 'https://fb.me/', call_to_action: { type: d.cta, value: { lead_gen_form_id: formId } } }),
});

// Every step is skipped if its id already exists, so a retry after a partial failure
// continues where it stopped instead of creating duplicates.
const createOnMeta = async ({ tenantId, userId, id, now = Date.now() }) => {
  const claimed = await query(
    "UPDATE ad_ai_drafts SET status = 'creating', error = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status IN ('draft','failed') RETURNING *",
    [tenantId, id]
  );
  if (!claimed.rows[0]) { await getDraft(tenantId, id); throw fail(409, 'This campaign is already being created or is on Meta.'); }
  const row = claimed.rows[0];
  const ids = { ...(row.meta_ids || {}) };
  const log = [...(row.api_log || [])];
  const save = (extra = {}) => query(
    'UPDATE ad_ai_drafts SET meta_ids = $3, api_log = $4, updated_at = now()' + Object.keys(extra).map((k, i) => `, ${k} = $${i + 5}`).join('') + ' WHERE tenant_id = $1 AND id = $2',
    [tenantId, id, JSON.stringify(ids), JSON.stringify(log), ...Object.values(extra)]
  );

  try {
    const { errors, draft: d } = validateDraft(row.edited, { offerText: row.brief?.offer, ...await budgetContext(tenantId) });
    if (errors.length) throw fail(422, `Fix ${errors.length} problem${errors.length > 1 ? 's' : ''} first: ${errors[0].message}`);
    if (!row.image?.hash) throw fail(422, 'Upload the ad image first.');
    const { token, act, pageId, pageToken } = await metaAccess(tenantId, row.ad_account_id);

    const call = async (step, opts) => {
      const entry = { step, method: opts.method || 'GET', path: opts.path, at: new Date().toISOString() };
      try {
        const res = await graphRequest({ gateKey: act, retries: 2, ...opts });
        log.push({ ...entry, ok: true, id: res.id || res.data?.[0]?.key || null });
        return res;
      } catch (e) {
        log.push({ ...entry, ok: false, error: e.message });
        throw fail(e.name === 'MetaGraphError' ? 400 : 502, `${step}: ${e.message}`);
      }
    };

    if (!ids.campaign_id) {
      const c = await call('Create campaign', { path: `/${act}/campaigns`, method: 'POST', token, data: {
        name: d.campaign_name, objective: 'OUTCOME_LEADS', status: 'PAUSED', buying_type: 'AUCTION',
        special_ad_categories: d.special_ad_categories, ...(d.special_ad_categories.length ? { special_ad_category_country: ['IN'] } : {}),
        daily_budget: String(d.daily_budget_inr * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      } });
      ids.campaign_id = c.id; await save();
    }
    if (!ids.city_key) {
      const geo = await call('Find city', { path: '/search', token, params: { type: 'adgeolocation', location_types: JSON.stringify(['city']), q: d.location, country_code: 'IN', limit: 1 } });
      if (!geo.data?.[0]?.key) throw fail(422, `Meta doesn't recognise the city "${d.location}". Use the city's common English name.`);
      ids.city_key = geo.data[0].key; ids.city_name = `${geo.data[0].name}${geo.data[0].region ? `, ${geo.data[0].region}` : ''}`; await save();
    }
    if (!ids.adset_id) {
      const broad = d.age_min === 18 && d.age_max === 65;
      const s = await call('Create ad set', { path: `/${act}/adsets`, method: 'POST', token, data: {
        name: `${d.campaign_name} — ${d.location}`, campaign_id: ids.campaign_id, status: 'PAUSED', billing_event: 'IMPRESSIONS',
        optimization_goal: d.destination === 'WHATSAPP' ? 'CONVERSATIONS' : 'LEAD_GENERATION',
        destination_type: d.destination === 'WHATSAPP' ? 'WHATSAPP' : 'ON_AD',
        promoted_object: { page_id: pageId },
        targeting: {
          geo_locations: { cities: [{ key: ids.city_key, radius: d.radius_km, distance_unit: 'kilometer' }] },
          age_min: d.age_min, age_max: d.age_max,
          targeting_automation: { advantage_audience: broad ? 1 : 0 },
        },
        start_time: new Date(now).toISOString(), end_time: new Date(now + d.duration_days * DAY_MS).toISOString(),
      } });
      ids.adset_id = s.id; await save();
    }
    if (d.destination === 'LEAD_FORM' && !ids.form_id) {
      if (d.lead_form.existing_form_id) ids.form_id = d.lead_form.existing_form_id;
      else {
        const f = await call('Create lead form', { path: `/${pageId}/leadgen_forms`, method: 'POST', token: pageToken, gateKey: `page:${pageId}`, data: {
          name: d.lead_form.name, questions: formQuestions(d.lead_form.questions),
          privacy_policy: { url: d.lead_form.privacy_policy_url, link_text: 'Privacy policy' }, locale: 'en_US',
        } });
        ids.form_id = f.id;
      }
      await save();
    }
    if (!ids.creative_id) {
      const cr = await call('Create creative', { path: `/${act}/adcreatives`, method: 'POST', token, data: {
        name: `${d.campaign_name} creative`, object_story_spec: { page_id: pageId, link_data: linkDataFor(d, row.image, ids.form_id) },
      } });
      ids.creative_id = cr.id; await save();
    }
    if (!ids.ad_id) {
      const ad = await call('Create ad', { path: `/${act}/ads`, method: 'POST', token, data: {
        name: d.campaign_name, adset_id: ids.adset_id, creative: { creative_id: ids.creative_id }, status: 'PAUSED',
      } });
      ids.ad_id = ad.id;
    }

    await save({ status: 'created' });
    await controls.audit({ query }, { tenantId, userId, adAccountId: row.ad_account_id, entityType: 'campaign', entityId: ids.campaign_id,
      entityName: d.campaign_name, action: 'create', newValue: { status: 'PAUSED', daily_budget_paise: d.daily_budget_inr * 100, meta_ids: ids }, success: true });
    await queues.enqueue('ads:sync-account', { tenantId, adAccountId: row.ad_account_id }, { jobId: `sync-${row.ad_account_id}` }).catch(() => {});
    return draftRow((await query('SELECT * FROM ad_ai_drafts WHERE id = $1', [id])).rows[0]);
  } catch (e) {
    await save({ status: 'failed', error: String(e.message).slice(0, 500) });
    throw e;
  }
};

// ── activate ───────────────────────────────────────────────────────────────
const activate = async ({ tenantId, userId, id, confirm }) => {
  const row = await getDraft(tenantId, id);
  const d = row.edited || {};
  if (row.status !== 'created') throw fail(409, row.status === 'activated' ? 'This campaign is already live.' : 'Create the campaign on Meta first.');
  if (String(confirm || '').trim() !== String(d.campaign_name || '').trim()) throw fail(422, 'Type the campaign name exactly to confirm it should start spending.');
  const { capPaise, activeDailyPaise } = await budgetContext(tenantId);
  if (capPaise && activeDailyPaise + d.daily_budget_inr * 100 > capPaise) {
    throw fail(422, `Starting this campaign would take your total daily ad budget over your cap of ₹${(capPaise / 100).toLocaleString('en-IN')}.`);
  }
  const { token, act } = await metaAccess(tenantId, row.ad_account_id);
  const ids = row.meta_ids || {};
  for (const [label, objId] of [['ad', ids.ad_id], ['ad set', ids.adset_id], ['campaign', ids.campaign_id]]) {
    try { await graphRequest({ path: `/${objId}`, method: 'POST', token, gateKey: act, data: { status: 'ACTIVE' }, retries: 2 }); }
    catch (e) {
      await controls.audit({ query }, { tenantId, userId, adAccountId: row.ad_account_id, entityType: 'campaign', entityId: ids.campaign_id, entityName: d.campaign_name,
        action: 'activate', oldValue: { status: 'PAUSED' }, request: { status: 'ACTIVE', object: label }, success: false, error: String(e.message).slice(0, 500) });
      throw fail(400, `Facebook couldn't start the ${label}: ${e.message}`);
    }
  }
  await query("UPDATE ad_ai_drafts SET status = 'activated', updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  await controls.audit({ query }, { tenantId, userId, adAccountId: row.ad_account_id, entityType: 'campaign', entityId: ids.campaign_id, entityName: d.campaign_name,
    action: 'activate', oldValue: { status: 'PAUSED' }, newValue: { status: 'ACTIVE' }, request: { status: 'ACTIVE' }, success: true });
  await queues.enqueue('ads:sync-account', { tenantId, adAccountId: row.ad_account_id }, { jobId: `sync-${row.ad_account_id}` }).catch(() => {});
  return { status: 'activated', meta_ids: ids };
};

module.exports = {
  validateBrief, buildMessages, generateDraft, listDrafts, getDraft: async (t, id) => draftRow(await getDraft(t, id)),
  updateDraft, uploadImage, createOnMeta, activate, formQuestions, linkDataFor,
};
