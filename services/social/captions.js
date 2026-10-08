const { callGroq } = require('../groqService');
const { LIMITS, countHashtags } = require('./rules');

// AI caption + hashtag ideas for a post. Every caption is cut to fit the strictest
// platform chosen, and hashtags are capped at Instagram's 30.

const LANGS = { en: 'English', hi: 'Hindi', mr: 'Marathi' };
const fail = (status, message) => Object.assign(new Error(message), { status });

const captionLimit = (platforms = []) => {
  const limits = platforms.map(p => LIMITS[p]?.caption).filter(Boolean);
  return limits.length ? Math.min(...limits) : LIMITS.instagram.caption;
};

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);
const tag = (h) => `#${String(h).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`;

// Pure: turns the model's JSON into { captions[3], hashtags[] } that fit the platforms.
const shapeCaptions = (raw, platforms) => {
  const max = captionLimit(platforms);
  const captions = (Array.isArray(raw?.captions) ? raw.captions : [])
    .map(c => String(c || '').trim()).filter(Boolean).slice(0, 3).map(c => clip(c, max));
  const hashtags = [...new Set((Array.isArray(raw?.hashtags) ? raw.hashtags : []).map(tag).filter(h => h.length > 1))]
    .slice(0, LIMITS.instagram.hashtags);
  // Leave room for hashtags in the captions' own count too.
  const budget = LIMITS.instagram.hashtags;
  return { captions: captions.map(c => (countHashtags(c) > budget ? c.replace(/(^|\s)#[^\s#]+/g, '').trim() : c)), hashtags, max_length: max };
};

const generateCaptions = async ({ prompt, language = 'en', platforms = [], businessName = '', businessAbout = '', groq = callGroq }) => {
  if (typeof prompt !== 'string' || prompt.trim().length < 3) throw fail(422, 'Describe what the post is about.');
  const lang = LANGS[language] || 'English';
  const max = captionLimit(platforms);
  const where = platforms.length ? platforms.map(p => ({ facebook: 'Facebook', instagram: 'Instagram', gbp: 'Google Business Profile' }[p])).join(', ') : 'Instagram and Facebook';
  const { content } = await groq([
    { role: 'system', content: `You write social media posts for small local businesses. Reply only with JSON: {"captions": ["…", "…", "…"], "hashtags": ["…"]}.
Three different captions in ${lang}, each under ${Math.min(max, 600)} characters, for ${where}. Friendly, specific, one clear call to action, at most 2 emojis.
No hashtags inside the captions. 8–15 relevant hashtags in the hashtags list (mix of local and topical, no #). Never invent prices, discounts or dates that aren't in the brief.` },
    { role: 'user', content: `Business: ${businessName || 'a local business'}${businessAbout ? `\nAbout: ${businessAbout.slice(0, 800)}` : ''}\nPost brief: ${prompt.trim().slice(0, 1000)}` },
  ], { json: true, maxTokens: 900, temperature: 0.7 });
  let raw;
  try { raw = JSON.parse(content); } catch { throw fail(502, 'The AI returned something unreadable. Try again.'); }
  const shaped = shapeCaptions(raw, platforms);
  if (!shaped.captions.length) throw fail(502, 'The AI didn\'t return any captions. Try again with a bit more detail.');
  return shaped;
};

module.exports = { generateCaptions, shapeCaptions, captionLimit };
