const axios = require('axios');

// Fetches a webpage and reduces it to plain readable text for feeding to an LLM —
// no HTML parser dependency, just enough tag-stripping to get real content out.
const fetchWebsiteText = async (url, maxChars = 6000) => {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const response = await axios.get(normalized, {
    timeout: 10000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CurveLeadBot/1.0)' },
  });

  const html = String(response.data);
  const text = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  if (!text) throw new Error('Could not read any content from that website.');
  return text.slice(0, maxChars);
};

module.exports = { fetchWebsiteText };
