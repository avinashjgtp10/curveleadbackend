// What each platform accepts (Phase 6). Pure — used by the API before saving and by the
// publisher before calling a platform, so a post that can't go out is refused up front
// with a reason instead of failing at the scheduled time.

const LIMITS = {
  facebook: { caption: 63206, maxMedia: 10 },
  instagram: { caption: 2200, hashtags: 30, maxMedia: 10, minAspect: 0.8, maxAspect: 1.91 },
  gbp: { caption: 1500, maxMedia: 1 },
  maxScheduleDays: 75,
};
const PLATFORM_NAMES = { facebook: 'Facebook', instagram: 'Instagram', gbp: 'Google Business Profile' };

const countHashtags = (text = '') => (text.match(/(^|\s)#[^\s#]+/g) || []).length;

// The post type follows from the media: none → feed, 1 image → photo, several → carousel,
// a video → video (an Instagram Reel).
const derivePostType = (media = []) => {
  if (!media.length) return 'feed';
  if (media.length === 1) return media[0].type === 'video' ? 'video' : 'photo';
  return 'carousel';
};

// Errors for one platform; empty array = OK.
const platformErrors = (platform, { caption = '', link_url, media = [] }) => {
  const name = PLATFORM_NAMES[platform];
  const videos = media.filter(m => m.type === 'video').length;
  const errs = [];
  const L = LIMITS[platform];
  if (caption.length > L.caption) errs.push(`${name}: the text is ${caption.length} characters; the limit is ${L.caption}.`);
  if (media.length > L.maxMedia) errs.push(`${name}: at most ${L.maxMedia} photo${L.maxMedia > 1 ? 's or videos' : ''} per post.`);

  if (platform === 'facebook') {
    if (!caption.trim() && !media.length && !link_url) errs.push('Facebook: add text, a link, or a photo or video.');
    if (videos && media.length > 1) errs.push('Facebook: post one video on its own, not mixed with photos.');
  }
  if (platform === 'instagram') {
    if (!media.length) errs.push('Instagram: add at least one photo or video — Instagram has no text-only posts.');
    if (countHashtags(caption) > L.hashtags) errs.push(`Instagram: at most ${L.hashtags} hashtags (this has ${countHashtags(caption)}).`);
    for (const m of media) {
      if (m.type !== 'image' || !m.width || !m.height) continue;
      const r = m.width / m.height;
      if (r < L.minAspect - 0.005 || r > L.maxAspect + 0.005) {
        errs.push(`Instagram: photos must be between 4:5 (portrait) and 1.91:1 (landscape); one is ${m.width}×${m.height}. Crop it and upload again.`);
        break;
      }
    }
  }
  if (platform === 'gbp') {
    if (!caption.trim()) errs.push('Google Business Profile: add text — Google needs a description for every post.');
    if (videos) errs.push('Google Business Profile: videos can\'t be posted through the API; use a photo.');
  }
  return errs;
};

// Validates a whole post for the platforms of the chosen accounts.
// scheduledAt: Date|null (null = publish now). Returns { ok, errors[] }.
const validatePost = ({ caption = '', link_url = null, media = [], platforms = [], scheduledAt = null, now = new Date() }) => {
  const errors = [];
  if (!platforms.length) errors.push('Choose at least one account to post to.');
  if (link_url && !/^https?:\/\/\S+$/i.test(link_url)) errors.push('The link must start with http:// or https://.');
  for (const p of [...new Set(platforms)]) errors.push(...platformErrors(p, { caption, link_url, media }));
  if (scheduledAt) {
    const t = scheduledAt.getTime();
    if (!Number.isFinite(t)) errors.push('Pick a valid date and time.');
    else if (t < now.getTime() - 60 * 1000) errors.push('That time has already passed — pick a later time or post now.');
    else if (t > now.getTime() + LIMITS.maxScheduleDays * 864e5) errors.push(`Posts can be scheduled up to ${LIMITS.maxScheduleDays} days ahead.`);
  }
  return { ok: errors.length === 0, errors };
};

module.exports = { LIMITS, PLATFORM_NAMES, countHashtags, derivePostType, platformErrors, validatePost };
