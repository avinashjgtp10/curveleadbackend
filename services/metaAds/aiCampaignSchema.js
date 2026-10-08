// Validation for AI-drafted Meta lead campaigns (Phase 5). Pure — no I/O — so the same
// rules run on the model's output, on every edit, and right before anything is created.

const LIMITS = {
  primaryTextHard: 2200, primaryTextRecommended: 125, headline: 40, description: 30,
  minDailyBudgetInr: 100, maxDurationDays: 90,
  // Meta city targeting accepts a radius of 17–80 km; special ad categories need ≥ 15 km anyway.
  minRadiusKm: 17, maxRadiusKm: 80,
  minAge: 18, maxAge: 65,
};

const CTAS = {
  LEAD_FORM: ['SIGN_UP', 'LEARN_MORE', 'GET_QUOTE', 'APPLY_NOW', 'BOOK_NOW', 'CONTACT_US', 'SUBSCRIBE', 'GET_OFFER', 'DOWNLOAD'],
  WHATSAPP: ['WHATSAPP_MESSAGE'],
};
const DESTINATIONS = Object.keys(CTAS);
const LANGUAGES = ['en', 'hi', 'mr'];

// Claims Meta's ad policies (and Indian advertising rules) reject, in English and common
// Hindi/Marathi transliterations. Matched as whole words / phrases, case-insensitively.
const BANNED_CLAIMS = [
  { re: /\bguarante+d?\b|\bguarantee\b|\bgaranti\b|\bgarantee\b|पक्की गारंटी|गॅरंटी|गारंटी/i, why: 'guarantees' },
  { re: /100\s?%|\bhundred percent\b|\bsau (?:taka|pratishat)\b|शत प्रतिशत|१००\s?%/i, why: '"100%" claims' },
  { re: /\bbefore\s*(?:&|and|\/)\s*after\b|\bpehle aur baad\b|पहले और बाद|आधी आणि नंतर/i, why: 'before/after claims' },
  { re: /\bcure[sd]?\b|\bpermanent(?:ly)? (?:cure|fix|remov)|\bilaaj\b|इलाज|बरा होईल|\bmiracle\b|\bchamatkar\b|चमत्कार/i, why: 'cure or miracle health claims' },
  { re: /\bget rich\b|\bearn (?:₹|rs\.?|inr)\s?\d|\bearn \d+\s?(?:k|lakh|lac)\b|\bpaise kamao\b|\bghar baithe kamai\b|घर बैठे कमाई|पैसे कमवा/i, why: 'income promises' },
  { re: /\blose \d+\s?kg\b|\b\d+\s?kg (?:in|within) \d+ days?\b|\bwazan kam\b.*\bdin\b/i, why: 'specific weight-loss promises' },
];

// Meta special ad categories: detected from the offer so the restrictions are applied.
const SPECIAL_CATEGORIES = [
  // Property terms only — not "ghar"/"घर" (home), which salon/home-service ads use all the time.
  { category: 'HOUSING', re: /\b(?:real estate|property|properties|flats?|apartments?|plots?|villas?|\d\s?bhk|bhk|for rent|rental|housing)\b|फ्लॅट|प्लॉट|मकान/i },
  { category: 'EMPLOYMENT', re: /\b(?:job|jobs|hiring|vacancy|vacancies|recruit\w*|career opportunit\w*|naukri|placement)\b|नौकरी|नोकरी|भरती/i },
  { category: 'FINANCIAL_PRODUCTS_SERVICES', re: /\b(?:loan|loans|credit|emi|insurance|mortgage|finance|financing|credit card|mutual fund)\b|कर्ज|लोन|बीमा/i },
];

const detectSpecialCategories = (text) => SPECIAL_CATEGORIES.filter(c => c.re.test(text || '')).map(c => c.category);

const bannedClaims = (text) => BANNED_CLAIMS.filter(b => b.re.test(text || '')).map(b => b.why);

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

// Coerces a model / client payload into the draft shape (unknown keys dropped).
const normalizeDraft = (d = {}) => ({
  campaign_name: str(d.campaign_name).slice(0, 120),
  destination: DESTINATIONS.includes(d.destination) ? d.destination : 'LEAD_FORM',
  location: str(d.location),
  radius_km: int(d.radius_km),
  age_min: int(d.age_min ?? LIMITS.minAge),
  age_max: int(d.age_max ?? LIMITS.maxAge),
  daily_budget_inr: int(d.daily_budget_inr),
  duration_days: int(d.duration_days),
  primary_texts: list(d.primary_texts).slice(0, 5),
  headlines: list(d.headlines).slice(0, 5),
  descriptions: list(d.descriptions).slice(0, 5),
  ctas: list(d.ctas).map(c => c.toUpperCase().replace(/\s+/g, '_')).slice(0, 5),
  // Which variant goes into the ad (the user picks on the review screen).
  primary_text_index: Math.max(0, int(d.primary_text_index) || 0),
  headline_index: Math.max(0, int(d.headline_index) || 0),
  cta: str(d.cta).toUpperCase().replace(/\s+/g, '_'),
  lead_form: {
    existing_form_id: str(d.lead_form?.existing_form_id) || null,
    name: str(d.lead_form?.name).slice(0, 100),
    questions: list(d.lead_form?.questions).slice(0, 8),
    privacy_policy_url: str(d.lead_form?.privacy_policy_url),
  },
  special_ad_categories: list(d.special_ad_categories).filter(c => SPECIAL_CATEGORIES.some(s => s.category === c)),
});

// Returns { errors: [{ field, message }], warnings: [...], draft } — draft has special
// categories merged in (keyword detection can only add, never remove).
const validateDraft = (input, { offerText = '', capPaise = null, activeDailyPaise = 0 } = {}) => {
  const d = normalizeDraft(input);
  const errors = [], warnings = [];
  const err = (field, message) => errors.push({ field, message });

  const detected = detectSpecialCategories([offerText, d.campaign_name, ...d.primary_texts, ...d.headlines].join(' '));
  d.special_ad_categories = [...new Set([...d.special_ad_categories, ...detected])];
  const special = d.special_ad_categories.length > 0;

  if (!d.campaign_name) err('campaign_name', 'Give the campaign a name.');
  if (!d.location) err('location', 'Say where to show the ads (a city).');
  if (!(d.radius_km >= LIMITS.minRadiusKm && d.radius_km <= LIMITS.maxRadiusKm)) err('radius_km', `Radius must be ${LIMITS.minRadiusKm}–${LIMITS.maxRadiusKm} km.`);
  if (!(d.daily_budget_inr >= LIMITS.minDailyBudgetInr)) err('daily_budget_inr', `Daily budget must be at least ₹${LIMITS.minDailyBudgetInr}.`);
  if (capPaise && activeDailyPaise + d.daily_budget_inr * 100 > capPaise) {
    err('daily_budget_inr', `With ₹${(activeDailyPaise / 100).toLocaleString('en-IN')} already set to spend per day, this would go over your daily cap of ₹${(capPaise / 100).toLocaleString('en-IN')}.`);
  }
  if (!(d.duration_days >= 1 && d.duration_days <= LIMITS.maxDurationDays)) err('duration_days', `Duration must be 1–${LIMITS.maxDurationDays} days.`);

  if (special) {
    // Meta: no age narrowing for housing, employment and credit/financial ads.
    if (d.age_min !== LIMITS.minAge || d.age_max !== LIMITS.maxAge) {
      warnings.push({ field: 'age_min', message: `${d.special_ad_categories.join(', ').toLowerCase().replace(/_/g, ' ')} ads can't target by age — set to 18–65+.` });
      d.age_min = LIMITS.minAge; d.age_max = LIMITS.maxAge;
    }
  } else if (!(d.age_min >= LIMITS.minAge && d.age_max <= LIMITS.maxAge && d.age_min <= d.age_max)) {
    err('age_min', `Age range must be within ${LIMITS.minAge}–${LIMITS.maxAge}.`);
  }

  if (!d.primary_texts.length) err('primary_texts', 'Add at least one primary text.');
  d.primary_texts.forEach((t, i) => {
    if (t.length > LIMITS.primaryTextHard) err(`primary_texts.${i}`, `Primary text ${i + 1} is over ${LIMITS.primaryTextHard} characters.`);
    else if (t.length > LIMITS.primaryTextRecommended) warnings.push({ field: `primary_texts.${i}`, message: `Primary text ${i + 1} is over ${LIMITS.primaryTextRecommended} characters — it will be cut off with "See more".` });
  });
  if (!d.headlines.length) err('headlines', 'Add at least one headline.');
  d.headlines.forEach((t, i) => { if (t.length > LIMITS.headline) err(`headlines.${i}`, `Headline ${i + 1} is over ${LIMITS.headline} characters.`); });
  d.descriptions.forEach((t, i) => { if (t.length > LIMITS.description) err(`descriptions.${i}`, `Description ${i + 1} is over ${LIMITS.description} characters.`); });
  if (d.primary_text_index >= Math.max(1, d.primary_texts.length)) d.primary_text_index = 0;
  if (d.headline_index >= Math.max(1, d.headlines.length)) d.headline_index = 0;

  if (!d.cta) d.cta = CTAS[d.destination][0];
  if (!CTAS[d.destination].includes(d.cta)) err('cta', `Button must be one of: ${CTAS[d.destination].map(c => c.replace(/_/g, ' ').toLowerCase()).join(', ')}.`);

  if (d.destination === 'LEAD_FORM' && !d.lead_form.existing_form_id) {
    if (!/^https:\/\/\S+\.\S+/.test(d.lead_form.privacy_policy_url)) err('lead_form.privacy_policy_url', 'A new lead form needs your privacy-policy link (https://…), or pick an existing form.');
    if (!d.lead_form.name) d.lead_form.name = `${d.campaign_name || 'Lead form'} form`.slice(0, 100);
  }

  const copy = [...d.primary_texts, ...d.headlines, ...d.descriptions].join('\n');
  for (const why of new Set(bannedClaims(copy))) err('copy', `Remove ${why} — Meta rejects ads that make them.`);

  return { errors, warnings, draft: d };
};

module.exports = { LIMITS, CTAS, DESTINATIONS, LANGUAGES, normalizeDraft, validateDraft, detectSpecialCategories, bannedClaims };
