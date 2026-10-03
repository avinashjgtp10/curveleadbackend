const db = require('../../config/db');
const gads = require('../../utils/googleAds');
const { callGroq } = require('../groqService');
const { getWorkspaceLocale } = require('../../utils/workspaceLocale');
const { validateSearchDraft, LIMITS } = require('./aiSearchSchema');
const { LANGUAGES } = require('../metaAds/aiCampaignSchema');
const metaControls = require('../metaAds/controls');
const { googleAccess } = require('./controls');
const queues = require('../../jobs/queues');

// Phase 7b: AI-drafted Google responsive search ads. Brief (Groq) → review/edit
// (re-validated) → created in Google Ads in ONE atomic request with the campaign PAUSED
// → activated as a separate, confirmed step. Drafts live in ad_ai_drafts (provider 'google').

const fail = (status, message) => Object.assign(new Error(message), { status });
const LANG_NAMES = { en: 'English', hi: 'Hindi (Devanagari script)', mr: 'Marathi (Devanagari script)' };
const DAY_MS = 864e5;
const query = (...a) => db.query(...a);

// ── context ────────────────────────────────────────────────────────────────
const primaryGoogleAccount = async (tenantId) => {
  const { rows } = await query(
    `SELECT a.id, a.currency FROM ad_accounts a JOIN ad_oauth_tokens t ON t.id = a.token_id AND t.tenant_id = a.tenant_id AND t.status = 'active'
     WHERE a.tenant_id = $1 AND a.provider = 'google' AND a.is_active ORDER BY a.is_primary DESC, a.created_at LIMIT 1`, [tenantId]);
  if (!rows[0]) throw fail(400, 'Connect a Google Ads account in Ads Manager → Google Ads first.');
  return rows[0];
};

// The workspace's best Google search ads by cost per conversion (≥ 3 conversions, last 90 days).
const topSearchAds = async (tenantId) => (await query(
  `SELECT ad.creative->'headlines' AS headlines, ad.creative->'descriptions' AS descriptions,
          sum(i.leads)::int AS conversions, round(sum(i.spend) / NULLIF(sum(i.leads), 0), 2)::float AS cost_per_conversion
   FROM ad_insights_daily i
   JOIN ad_ads ad ON ad.tenant_id = i.tenant_id AND ad.external_id = i.entity_id
   JOIN ad_accounts a ON a.id = i.ad_account_id AND a.tenant_id = i.tenant_id AND a.provider = 'google'
   WHERE i.tenant_id = $1 AND i.entity_type = 'ad' AND i.date >= current_date - 90 AND ad.creative->>'type' = 'RESPONSIVE_SEARCH_AD'
   GROUP BY ad.id HAVING sum(i.leads) >= 3 ORDER BY cost_per_conversion ASC NULLS LAST LIMIT 3`, [tenantId])).rows;

const budgetContext = async (tenantId) => {
  const { campaigns, adsets } = await metaControls.workspaceBudgets(tenantId);
  return { capPaise: await metaControls.budgetCap(tenantId), activeDailyPaise: metaControls.dailyBudgetTotal(campaigns, adsets) };
};

// ── brief → draft ──────────────────────────────────────────────────────────
const validateBrief = (b = {}, { website = '' } = {}) => {
  const brief = {
    offer: String(b.offer || '').trim().slice(0, 600),
    location: String(b.location || '').trim().slice(0, 80),
    budget_per_day_inr: Math.round(Number(b.budget_per_day_inr)),
    duration_days: Math.round(Number(b.duration_days)),
    goal: String(b.goal || '').trim().slice(0, 300),
    language: LANGUAGES.includes(b.language) ? b.language : 'en',
    final_url: String(b.final_url || website || '').trim().slice(0, 500),
  };
  if (brief.offer.length < 10) throw fail(422, 'Describe the offer in a sentence or two.');
  if (!brief.location) throw fail(422, 'Say which city to advertise in.');
  if (!/^https?:\/\/\S+\.\S+/i.test(brief.final_url)) throw fail(422, 'Enter the page people should land on (https://…). Search ads need a website.');
  if (!(brief.budget_per_day_inr >= LIMITS.minDailyBudget)) throw fail(422, `Daily budget must be at least ${LIMITS.minDailyBudget}.`);
  if (!(brief.duration_days >= 1 && brief.duration_days <= LIMITS.maxDurationDays)) throw fail(422, `Duration must be 1–${LIMITS.maxDurationDays} days.`);
  return brief;
};

const buildMessages = ({ brief, businessName, businessDescription, top }) => [
  {
    role: 'system',
    content: `You write Google Search ads (responsive search ads) for small Indian businesses. Reply with JSON only.
Ad text in ${LANG_NAMES[brief.language]}. Headlines: 12–15, each at most 30 characters, all different, no "!" at all. Descriptions: 4, each at most 90 characters, at most one "!" each.
Never promise guaranteed or 100% results, before/after results, cures, miracle or permanent health results, or income. No phone numbers, no words in capitals, no repeated punctuation.
Mix headlines about the offer, the place, price/value, trust and a clear next step. Use the city name in some headlines.
Keywords: 10–20 search terms people in India really type into Google to find this (often English or Hinglish even when the ads are in another language), each with match_type PHRASE or EXACT; include the city in several. Negative keywords: 5–15 words that bring the wrong people (e.g. jobs, free, course, salary) — only ones that don't conflict with the offer.
Display paths: path1 and path2, each at most 15 characters, no spaces (use hyphens).
JSON shape: {"campaign_name": string (short, English), "headlines": string[], "descriptions": string[], "keywords": [{"text": string, "match_type": "PHRASE"|"EXACT"}], "negative_keywords": string[], "path1": string, "path2": string, "reasoning": string (one sentence, English)}`,
  },
  {
    role: 'user',
    content: JSON.stringify({
      business: businessName, about: businessDescription || undefined,
      offer: brief.offer, goal: brief.goal || undefined, city: brief.location, landing_page: brief.final_url,
      daily_budget: brief.budget_per_day_inr, duration_days: brief.duration_days,
      best_past_search_ads: top.length ? top : undefined,
    }),
  },
];

// Models often overshoot the length limits. Drop the over-long variants when enough
// good ones remain; otherwise keep them for the user to shorten.
const trimOverLong = (items, max, keepAtLeast) => {
  const ok = (items || []).filter(t => typeof t === 'string' && t.trim().length <= max);
  return ok.length >= keepAtLeast ? ok : (items || []);
};

const draftRow = (r, warnings = []) => r && ({
  id: r.id, provider: 'google', status: r.status, brief: r.brief, draft: r.edited, ai_reasoning: r.ai_output?.reasoning || null,
  errors: r.validation_errors || [], warnings, ids: r.meta_ids || {}, api_log: r.api_log, error: r.error, created_at: r.created_at, updated_at: r.updated_at,
});

const generateDraft = async ({ tenantId, userId, brief: rawBrief }) => {
  const account = await primaryGoogleAccount(tenantId);
  const tenant = (await query('SELECT name, website, settings FROM tenants WHERE id = $1', [tenantId])).rows[0] || {};
  const brief = validateBrief(rawBrief, { website: tenant.website });
  const result = await callGroq(buildMessages({ brief, businessName: tenant.name, businessDescription: tenant.settings?.business_description, top: await topSearchAds(tenantId) }),
    { json: true, temperature: 0.6, maxTokens: 2200 });
  let ai;
  try { ai = JSON.parse(result.content); } catch { throw fail(502, 'The AI returned an unusable draft. Please try again.'); }
  if (!Array.isArray(ai.headlines) || !ai.headlines.length) throw fail(502, 'The AI did not return any ad copy. Check that AI is configured, then try again.');

  const candidate = {
    campaign_name: ai.campaign_name || `Search – ${brief.offer.slice(0, 40)} – ${brief.location}`,
    final_url: brief.final_url, path1: ai.path1, path2: ai.path2, location: brief.location, language: brief.language,
    daily_budget_inr: brief.budget_per_day_inr, duration_days: brief.duration_days,
    headlines: trimOverLong(ai.headlines, LIMITS.headline, LIMITS.goodHeadlines),
    descriptions: trimOverLong(ai.descriptions, LIMITS.description, LIMITS.minDescriptions),
    keywords: ai.keywords, negative_keywords: ai.negative_keywords,
  };
  const { errors, warnings, draft } = validateSearchDraft(candidate, { ...await budgetContext(tenantId), currency: account.currency || 'INR' });
  const { rows } = await query(
    `INSERT INTO ad_ai_drafts (tenant_id, user_id, ad_account_id, provider, brief, ai_output, edited, validation_errors)
     VALUES ($1,$2,$3,'google',$4,$5,$6,$7) RETURNING *`,
    [tenantId, userId, account.id, JSON.stringify(brief), JSON.stringify(ai), JSON.stringify(draft), JSON.stringify(errors)]);
  return draftRow(rows[0], warnings);
};

const loadDraft = async (tenantId, id) => {
  const { rows } = await query("SELECT * FROM ad_ai_drafts WHERE tenant_id = $1 AND id = $2 AND provider = 'google'", [tenantId, id]);
  if (!rows[0]) throw fail(404, 'Draft not found.');
  return rows[0];
};

const accountCurrency = async (tenantId, adAccountId) =>
  (await query('SELECT currency FROM ad_accounts WHERE tenant_id = $1 AND id = $2', [tenantId, adAccountId])).rows[0]?.currency || 'INR';

const getDraft = async (tenantId, id) => {
  const row = await loadDraft(tenantId, id);
  const { warnings } = validateSearchDraft(row.edited, { currency: await accountCurrency(tenantId, row.ad_account_id) });
  return draftRow(row, warnings);
};

const listDrafts = async (tenantId) => (await query(
  `SELECT id, status, brief, edited, validation_errors, meta_ids, error, created_at
   FROM ad_ai_drafts WHERE tenant_id = $1 AND provider = 'google' ORDER BY created_at DESC LIMIT 30`, [tenantId]
)).rows.map(r => ({ id: r.id, status: r.status, campaign_name: r.edited?.campaign_name, brief: r.brief, daily_budget_inr: r.edited?.daily_budget_inr,
  error_count: (r.validation_errors || []).length, ids: r.meta_ids, error: r.error, created_at: r.created_at }));

const updateDraft = async ({ tenantId, id, draft }) => {
  const row = await loadDraft(tenantId, id);
  if (!['draft', 'failed'].includes(row.status)) throw fail(409, 'This campaign is already in Google Ads and can no longer be edited here.');
  const { errors, warnings, draft: clean } = validateSearchDraft(draft, { ...await budgetContext(tenantId), currency: await accountCurrency(tenantId, row.ad_account_id) });
  const { rows } = await query('UPDATE ad_ai_drafts SET edited = $3, validation_errors = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [tenantId, id, JSON.stringify(clean), JSON.stringify(errors)]);
  return draftRow(rows[0], warnings);
};

// ── create (paused) ────────────────────────────────────────────────────────
// "YYYY-MM-DD" today in the ad account's timezone (Google's dates are in it).
const accountDate = (now, timezone, plusDays = 0) => {
  const tz = (() => { try { new Intl.DateTimeFormat('en', { timeZone: timezone }); return timezone; } catch { return 'Asia/Kolkata'; } })();
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(now + plusDays * DAY_MS));
};
const endDateTime = (now, timezone, days) => `${accountDate(now, timezone, days - 1)} 23:59:59`;

// Pure: every operation for one atomic googleAds:mutate, plus a label per operation so a
// rejected one can be named. Temporary ids: -1 budget, -2 campaign, -3 ad group.
const buildOperations = ({ d, customerId, geoTarget, languages, draftId, now, timezone }) => {
  const C = `customers/${gads.digits(customerId)}`;
  const budget = `${C}/campaignBudgets/-1`, campaign = `${C}/campaigns/-2`, adGroup = `${C}/adGroups/-3`;
  const ops = [], labels = [];
  const add = (label, op) => { labels.push(label); ops.push(op); };
  add('Budget', { campaignBudgetOperation: { create: {
    resourceName: budget, name: `${d.campaign_name} budget ${String(draftId).slice(0, 8)}`,
    amountMicros: String(d.daily_budget_inr * 1e6), deliveryMethod: 'STANDARD', explicitlyShared: false,
  } } });
  add('Campaign', { campaignOperation: { create: {
    resourceName: campaign, name: d.campaign_name, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget,
    targetSpend: {}, // Maximize clicks: works without conversion tracking.
    networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
    startDateTime: `${accountDate(now, timezone)} 00:00:00`, endDateTime: endDateTime(now, timezone, d.duration_days),
    containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  } } });
  add(`Location ${d.location}`, { campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: geoTarget } } } });
  for (const l of languages) add(`Language ${l.code}`, { campaignCriterionOperation: { create: { campaign, language: { languageConstant: l.resourceName } } } });
  for (const text of d.negative_keywords) add(`Negative keyword "${text}"`, { campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text, matchType: 'BROAD' } } } });
  add('Ad group', { adGroupOperation: { create: { resourceName: adGroup, campaign, name: `${d.campaign_name} – ${d.location}`.slice(0, 255), status: 'ENABLED', type: 'SEARCH_STANDARD' } } });
  for (const k of d.keywords) add(`Keyword "${k.text}"`, { adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text: k.text, matchType: k.match_type } } } });
  add('Ad', { adGroupAdOperation: { create: { adGroup, status: 'ENABLED', ad: {
    finalUrls: [d.final_url],
    responsiveSearchAd: { headlines: d.headlines.map(text => ({ text })), descriptions: d.descriptions.map(text => ({ text })),
      ...(d.path1 ? { path1: d.path1 } : {}), ...(d.path2 ? { path2: d.path2 } : {}) },
  } } } });
  return { ops, labels };
};

// Pure: resource names from the mutate response, in operation order.
const idsFromResponse = (body, labels) => {
  const ids = { keywords: 0 };
  (body?.mutateOperationResponses || []).forEach((r, i) => {
    const name = Object.values(r || {})[0]?.resourceName;
    if (r.campaignBudgetResult) ids.budget = name;
    else if (r.campaignResult) ids.campaign = name;
    else if (r.adGroupResult) ids.ad_group = name;
    else if (r.adGroupAdResult) ids.ad = name;
    else if (r.adGroupCriterionResult && /^Keyword/.test(labels[i])) ids.keywords++;
  });
  ids.campaign_id = ids.campaign ? ids.campaign.split('/').pop() : null;
  return ids;
};

// Pure: Google's per-operation errors → one readable sentence naming what was rejected.
const explainMutateError = (e, labels) => {
  const parts = (e.errors || []).slice(0, 3).map(x => {
    const opIndex = x.path.find(p => p.field === 'mutate_operations')?.index;
    const what = opIndex != null && labels[opIndex] ? `${labels[opIndex]}: ` : '';
    return `${what}${x.message}${x.trigger ? ` ("${x.trigger}")` : ''}`;
  });
  if (e.code === 'DUPLICATE_CAMPAIGN_NAME') return 'A campaign with this name already exists in Google Ads — rename this one. (If CurveLead created it before, check Google Ads first.)';
  return parts.length ? `Google Ads rejected it — ${parts.join('; ')}${(e.errors || []).length > 3 ? ` (and ${e.errors.length - 3} more)` : ''}` : e.message;
};

const findGeoTarget = async ({ location, countryCode, accessToken, call = gads.call }) => {
  const body = await call({ method: 'POST', path: '/geoTargetConstants:suggest', accessToken,
    data: { locale: 'en', countryCode, locationNames: { names: [location] } } });
  const found = (body.geoTargetConstantSuggestions || []).map(s => s.geoTargetConstant).filter(g => g && g.status !== 'REMOVAL_PLANNED');
  const best = found.find(g => g.targetType === 'City') || found[0];
  if (!best) throw fail(422, `Google doesn't recognise the place "${location}". Use the city's common English name.`);
  return { resourceName: best.resourceName, name: best.canonicalName || best.name };
};

// English plus the ad's language: most people in India keep Google in English.
const findLanguages = async ({ language, search, opts }) => {
  const codes = [...new Set(['en', language])];
  const rows = await search({ ...opts, gaql: `SELECT language_constant.resource_name, language_constant.code FROM language_constant WHERE language_constant.code IN (${codes.map(c => `'${c}'`).join(', ')})` });
  return rows.map(r => ({ code: r.languageConstant.code, resourceName: r.languageConstant.resourceName }));
};

const createOnGoogle = async ({ tenantId, userId, id, now = Date.now() }, deps = {}) => {
  const search = deps.search || gads.search;
  const mutate = deps.mutate || gads.mutate;
  const claimed = await query(
    "UPDATE ad_ai_drafts SET status = 'creating', error = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND provider = 'google' AND status IN ('draft','failed') RETURNING *",
    [tenantId, id]);
  if (!claimed.rows[0]) { await loadDraft(tenantId, id); throw fail(409, 'This campaign is already being created or is in Google Ads.'); }
  const row = claimed.rows[0];
  const log = [...(row.api_log || [])];
  const save = (fields) => query(
    `UPDATE ad_ai_drafts SET api_log = $3, ${Object.keys(fields).map((k, i) => `${k} = $${i + 4}`).join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, JSON.stringify(log), ...Object.values(fields)]);

  try {
    const { account, opts } = await (deps.googleAccess || googleAccess)(tenantId, row.ad_account_id);
    const { errors, draft: d } = validateSearchDraft(row.edited, { ...await budgetContext(tenantId), currency: account.currency || 'INR' });
    if (errors.length) throw fail(422, `Fix ${errors.length} problem${errors.length > 1 ? 's' : ''} first: ${errors[0].message}`);
    const { country } = await getWorkspaceLocale(tenantId);

    const step = async (name, fn) => {
      const entry = { step: name, at: new Date().toISOString() };
      try { const r = await fn(); log.push({ ...entry, ok: true }); return r; }
      catch (e) { log.push({ ...entry, ok: false, error: String(e.message).slice(0, 300) }); throw e; }
    };
    const geo = await step('Find location', () => findGeoTarget({ location: d.location, countryCode: country || 'IN', accessToken: opts.accessToken, call: deps.call }));
    const languages = await step('Find languages', () => findLanguages({ language: d.language, search, opts }));
    const { ops, labels } = buildOperations({ d, customerId: account.external_id, geoTarget: geo.resourceName, languages, draftId: id, now, timezone: account.timezone_name });

    let body;
    try {
      body = await step(`Create campaign (${ops.length} items, all or nothing)`, () => mutate({ ...opts, operations: ops }));
    } catch (e) {
      if (e.name === 'GoogleAdsError') throw fail(e.status === 503 ? 503 : 400, explainMutateError(e, labels));
      throw e;
    }
    const ids = { ...idsFromResponse(body, labels), location: geo.name };
    await save({ meta_ids: JSON.stringify(ids), status: 'created' });
    await metaControls.audit({ query }, { tenantId, userId, adAccountId: row.ad_account_id, entityType: 'campaign', entityId: ids.campaign_id, entityName: d.campaign_name,
      action: 'create', newValue: { status: 'PAUSED', daily_budget_paise: d.daily_budget_inr * 100, ids }, success: true, provider: 'google' });
    await queues.enqueue('ads:sync-account', { tenantId, adAccountId: row.ad_account_id }, { jobId: `sync-${row.ad_account_id}-${Date.now()}` }).catch(() => {});
    return draftRow((await query('SELECT * FROM ad_ai_drafts WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0]);
  } catch (e) {
    await save({ status: 'failed', error: String(e.message).slice(0, 500) });
    throw e;
  }
};

// ── activate ───────────────────────────────────────────────────────────────
// Starts the campaign and moves its end date so it runs the full duration from today.
const activate = async ({ tenantId, userId, id, confirm, now = Date.now() }, deps = {}) => {
  const mutate = deps.mutate || gads.mutate;
  const row = await loadDraft(tenantId, id);
  const d = row.edited || {};
  if (row.status !== 'created') throw fail(409, row.status === 'activated' ? 'This campaign is already live.' : 'Create the campaign in Google Ads first.');
  if (String(confirm || '').trim() !== String(d.campaign_name || '').trim()) throw fail(422, 'Type the campaign name exactly to confirm it should start spending.');
  const { account, opts } = await (deps.googleAccess || googleAccess)(tenantId, row.ad_account_id);
  const { capPaise, activeDailyPaise } = await budgetContext(tenantId);
  if (capPaise && activeDailyPaise + d.daily_budget_inr * 100 > capPaise) {
    throw fail(422, `Starting this campaign would take your total daily ad budget over your cap of ${metaControls.money(capPaise, account.currency)}.`);
  }
  const ids = row.meta_ids || {};
  const update = { resourceName: ids.campaign, status: 'ENABLED', endDateTime: endDateTime(now, account.timezone_name, d.duration_days) };
  const auditBase = { tenantId, userId, adAccountId: row.ad_account_id, entityType: 'campaign', entityId: ids.campaign_id, entityName: d.campaign_name,
    action: 'activate', oldValue: { status: 'PAUSED' }, request: update, provider: 'google' };
  try {
    await mutate({ ...opts, operations: [{ campaignOperation: { update, updateMask: 'status,end_date_time' } }] });
  } catch (e) {
    await metaControls.audit({ query }, { ...auditBase, success: false, error: String(e.message).slice(0, 500) });
    throw fail(400, `Google Ads couldn't start the campaign: ${e.message}`);
  }
  await query("UPDATE ad_ai_drafts SET status = 'activated', updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  await metaControls.audit({ query }, { ...auditBase, newValue: { status: 'ENABLED', end_date_time: update.endDateTime }, success: true });
  await queues.enqueue('ads:sync-account', { tenantId, adAccountId: row.ad_account_id }, { jobId: `sync-${row.ad_account_id}-${Date.now()}` }).catch(() => {});
  return { status: 'activated', ids };
};

module.exports = {
  validateBrief, buildMessages, generateDraft, listDrafts, getDraft, updateDraft, createOnGoogle, activate,
  buildOperations, idsFromResponse, explainMutateError, trimOverLong, endDateTime,
};
