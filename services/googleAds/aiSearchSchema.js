// Validation for AI-drafted Google responsive search ads (Phase 7b). Pure — no I/O — so the
// same rules run on the model's output, on every edit, and right before anything is created.
const { bannedClaims, detectSpecialCategories, LANGUAGES } = require('../metaAds/aiCampaignSchema');

const LIMITS = {
  headline: 30, description: 90, path: 15,
  minHeadlines: 3, maxHeadlines: 15, goodHeadlines: 8,
  minDescriptions: 2, maxDescriptions: 4,
  minKeywords: 1, maxKeywords: 30, keywordChars: 80, keywordWords: 10, maxNegatives: 30,
  minDailyBudget: 100, maxDurationDays: 90,
};
const MATCH_TYPES = ['BROAD', 'PHRASE', 'EXACT'];

// Characters Google doesn't accept in keywords.
const KEYWORD_BAD_CHARS = /[!@%,*()=^;~`<>?\\|{}]/;
// Google's editorial rules for ad text.
const PHONE = /(?:\d[\s-]?){10,}/;
const REPEATED_PUNCT = /([!?])\1|\.{4,}|[!?]{2,}/;
// Words of 4+ capital letters read as shouting; common Indian acronyms are fine.
const ACRONYMS = new Set(['BHK', 'EMI', 'RERA', 'IELTS', 'NEET', 'UPSC', 'MBBS', 'CBSE', 'ICSE', 'PMAY', 'CCTV', 'UPVC', 'HVAC', 'MPSC', 'GATE', 'TOEFL', 'ISO', 'ICICI', 'HDFC', 'NABH']);
const shouting = (t) => (String(t).match(/\b[A-Z]{4,}\b/g) || []).filter(w => !ACRONYMS.has(w));

const str = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const money = (amount, currency = 'INR') => {
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount); }
  catch { return `${currency} ${amount}`; }
};

// "[hair spa pune]" → exact, "\"hair spa\"" → phrase, otherwise the given or default type.
const parseKeyword = (k) => {
  const raw = typeof k === 'string' ? { text: k } : (k || {});
  let text = str(raw.text);
  let match = String(raw.match_type || '').toUpperCase();
  if (/^\[.*\]$/.test(text)) { text = text.slice(1, -1).trim(); match = 'EXACT'; }
  else if (/^".*"$/.test(text)) { text = text.slice(1, -1).trim(); match = 'PHRASE'; }
  text = text.replace(/^\+|\s\+/g, ' ').trim().toLowerCase();
  return { text, match_type: MATCH_TYPES.includes(match) ? match : 'PHRASE' };
};
const uniqueBy = (arr, key) => {
  const seen = new Set();
  return arr.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
};

// Coerces a model / client payload into the draft shape (unknown keys dropped).
const normalizeSearchDraft = (d = {}) => ({
  campaign_name: str(d.campaign_name).slice(0, 120),
  final_url: str(d.final_url),
  path1: str(d.path1).replace(/[\s/]+/g, '-'),
  path2: str(d.path2).replace(/[\s/]+/g, '-'),
  location: str(d.location),
  language: LANGUAGES.includes(d.language) ? d.language : 'en',
  daily_budget_inr: int(d.daily_budget_inr),
  duration_days: int(d.duration_days),
  headlines: list(d.headlines).slice(0, LIMITS.maxHeadlines),
  descriptions: list(d.descriptions).slice(0, LIMITS.maxDescriptions),
  keywords: uniqueBy((Array.isArray(d.keywords) ? d.keywords : []).map(parseKeyword).filter(k => k.text), k => `${k.text}|${k.match_type}`).slice(0, LIMITS.maxKeywords),
  negative_keywords: uniqueBy(list(d.negative_keywords).map(t => parseKeyword(t).text).filter(Boolean), t => t).slice(0, LIMITS.maxNegatives),
});

const duplicates = (arr) => {
  const seen = new Map();
  arr.forEach((t, i) => { const k = t.toLowerCase(); seen.set(k, [...(seen.get(k) || []), i]); });
  return [...seen.values()].filter(ix => ix.length > 1).map(ix => ix[ix.length - 1]);
};

// Returns { errors: [{ field, message }], warnings: [...], draft }.
const validateSearchDraft = (input, { capPaise = null, activeDailyPaise = 0, currency = 'INR' } = {}) => {
  const d = normalizeSearchDraft(input);
  const errors = [], warnings = [];
  const err = (field, message) => errors.push({ field, message });
  const warn = (field, message) => warnings.push({ field, message });

  if (!d.campaign_name) err('campaign_name', 'Give the campaign a name.');
  if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(d.final_url)) err('final_url', 'Enter the page people land on (https://…).');
  else if (/^http:/i.test(d.final_url)) warn('final_url', 'Use an https:// link if your site has one — Google may flag http pages.');
  if (d.path2 && !d.path1) err('path1', 'Fill the first display path before the second.');
  if (d.path1.length > LIMITS.path) err('path1', `Display path 1 is over ${LIMITS.path} characters.`);
  if (d.path2.length > LIMITS.path) err('path2', `Display path 2 is over ${LIMITS.path} characters.`);
  if (!d.location) err('location', 'Say where to show the ads (a city).');

  if (!(d.daily_budget_inr >= LIMITS.minDailyBudget)) err('daily_budget_inr', `Daily budget must be at least ${money(LIMITS.minDailyBudget, currency)}.`);
  else if (capPaise && activeDailyPaise + d.daily_budget_inr * 100 > capPaise) {
    err('daily_budget_inr', `With ${money(activeDailyPaise / 100, currency)} already set to spend per day, this would go over your daily cap of ${money(capPaise / 100, currency)}.`);
  }
  if (!(d.duration_days >= 1 && d.duration_days <= LIMITS.maxDurationDays)) err('duration_days', `Duration must be 1–${LIMITS.maxDurationDays} days.`);

  if (d.headlines.length < LIMITS.minHeadlines) err('headlines', `Add at least ${LIMITS.minHeadlines} headlines.`);
  else if (d.headlines.length < LIMITS.goodHeadlines) warn('headlines', `Google rates ads with ${LIMITS.goodHeadlines}–15 headlines better — add a few more.`);
  d.headlines.forEach((t, i) => {
    if (t.length > LIMITS.headline) err(`headlines.${i}`, `Headline ${i + 1} is over ${LIMITS.headline} characters.`);
    if (t.includes('!')) err(`headlines.${i}`, `Headline ${i + 1}: Google doesn't allow "!" in headlines.`);
  });
  for (const i of duplicates(d.headlines)) err(`headlines.${i}`, `Headline ${i + 1} repeats another headline.`);

  if (d.descriptions.length < LIMITS.minDescriptions) err('descriptions', `Add at least ${LIMITS.minDescriptions} descriptions.`);
  d.descriptions.forEach((t, i) => {
    if (t.length > LIMITS.description) err(`descriptions.${i}`, `Description ${i + 1} is over ${LIMITS.description} characters.`);
    if ((t.match(/!/g) || []).length > 1) err(`descriptions.${i}`, `Description ${i + 1}: Google allows only one "!" per description.`);
  });
  for (const i of duplicates(d.descriptions)) err(`descriptions.${i}`, `Description ${i + 1} repeats another description.`);

  if (d.keywords.length < LIMITS.minKeywords) err('keywords', 'Add at least one keyword.');
  d.keywords.forEach((k, i) => {
    if (k.text.length > LIMITS.keywordChars) err(`keywords.${i}`, `Keyword "${k.text}" is over ${LIMITS.keywordChars} characters.`);
    if (k.text.split(' ').length > LIMITS.keywordWords) err(`keywords.${i}`, `Keyword "${k.text}" has more than ${LIMITS.keywordWords} words.`);
    if (KEYWORD_BAD_CHARS.test(k.text)) err(`keywords.${i}`, `Keyword "${k.text}" has symbols Google doesn't accept (like ! @ % , *).`);
  });
  d.negative_keywords.forEach((t, i) => { if (KEYWORD_BAD_CHARS.test(t)) err(`negative_keywords.${i}`, `Negative keyword "${t}" has symbols Google doesn't accept.`); });
  const negatives = new Set(d.negative_keywords);
  d.keywords.forEach((k, i) => { if (negatives.has(k.text)) err(`keywords.${i}`, `"${k.text}" is both a keyword and a negative keyword.`); });

  const copy = [...d.headlines, ...d.descriptions];
  if (copy.some(t => PHONE.test(t))) err('copy', 'Remove phone numbers from the ad text — Google shows your number with a call asset instead.');
  if (copy.some(t => REPEATED_PUNCT.test(t))) err('copy', 'Remove repeated punctuation (like "!!" or "??") — Google rejects it.');
  const loud = [...new Set(copy.flatMap(shouting))];
  if (loud.length) warn('copy', `Google may reject words in capitals (${loud.slice(0, 3).join(', ')}) unless they're a brand name — write them normally.`);
  for (const why of new Set(bannedClaims(copy.join('\n')))) err('copy', `Remove ${why} — Google rejects ads that make them.`);
  if (detectSpecialCategories([d.campaign_name, ...copy, ...d.keywords.map(k => k.text)].join(' ')).includes('FINANCIAL_PRODUCTS_SERVICES')) {
    warn('copy', 'Loans, credit and insurance ads in India need Google\'s financial services verification on the account, or they won\'t run.');
  }

  return { errors, warnings, draft: d };
};

module.exports = { LIMITS, MATCH_TYPES, normalizeSearchDraft, validateSearchDraft, parseKeyword };
