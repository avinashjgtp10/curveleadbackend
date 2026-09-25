const axios = require('axios');
const FormData = require('form-data');

const IDEOGRAM_URL = 'https://api.ideogram.ai/v1/ideogram-v3/generate';

// Direct generation switches on when a key is present. Without one, the UI still
// hands the user a ready-made prompt to use on ideogram.ai and upload the result.
const isConfigured = () => !!process.env.IDEOGRAM_API_KEY;

// Ideogram renders quoted text best, so the banner wording goes in quotes verbatim.
const buildImagePrompt = ({ businessName, idea, headline, subline, cta }) => {
  const scene = idea || 'a happy customer enjoying the service, warm inviting lighting';
  const text = [
    headline && `Large headline text reading "${headline}"`,
    subline && `smaller text below it reading "${subline}"`,
    cta && `a small rounded button-style label reading "${cta}"`,
  ].filter(Boolean).join(', ');
  return [
    `Clean promotional banner for ${businessName || 'a local business'}, wide landscape layout.`,
    `${scene}.`,
    text ? `${text}.` : '',
    'Bold elegant sans-serif typography, spelled exactly as written, with clean empty space around the text.',
    'Modern Instagram ad style, professional advertising photography, balanced colour palette.',
  ].filter(Boolean).join(' ');
};

// Returns [{ mime, base64 }]. Ideogram's image links expire, so the images are
// downloaded here and handed back as data the caller can keep.
const generateImages = async ({ prompt, count = 2 }) => {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('aspect_ratio', '16x9');
  form.append('style_type', 'DESIGN');
  form.append('num_images', String(Math.min(Math.max(count, 1), 3)));

  let response;
  try {
    response = await axios.post(IDEOGRAM_URL, form, {
      headers: { ...form.getHeaders(), 'Api-Key': process.env.IDEOGRAM_API_KEY },
      timeout: 90000,
    });
  } catch (e) {
    const detail = e.response?.data?.error || e.response?.data?.message || e.message;
    throw new Error(`Image generation failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }

  const items = (response.data?.data || []).filter(i => i.url && i.is_image_safe !== false);
  if (!items.length) throw new Error('No usable image came back (it may have been flagged). Try changing the prompt.');

  return Promise.all(items.map(async (item) => {
    const img = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 30000 });
    return { mime: img.headers['content-type'] || 'image/png', base64: Buffer.from(img.data).toString('base64') };
  }));
};

module.exports = { isConfigured, buildImagePrompt, generateImages };
