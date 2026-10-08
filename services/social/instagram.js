const { graphRequest } = require('../../utils/metaGraph');

// Instagram content publishing: create a media container, wait until Instagram has
// processed it (videos take a while), then publish it. Uses the linked Page's token.

class InstagramError extends Error {
  constructor(message, { retryable = false } = {}) { super(message); this.name = 'InstagramError'; this.retryable = retryable; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Waits for a container to be FINISHED. Images are usually ready at once; Reels can
// take minutes. ERROR / EXPIRED are final.
const waitForContainer = async ({ id, token, graph, gateKey, pollMs = 5000, maxPolls = 60, _sleep = sleep }) => {
  for (let i = 0; i < maxPolls; i++) {
    const { status_code: code, status } = await graph({ path: `/${id}`, token, params: { fields: 'status_code,status' }, gateKey, retries: 2 });
    if (code === 'FINISHED' || code === 'PUBLISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') throw new InstagramError(`Instagram couldn't process the media${status ? ` (${status})` : ''}. Check the format and try again.`);
    await _sleep(pollMs);
  }
  throw new InstagramError('Instagram is still processing the video. It will be retried.', { retryable: true });
};

// Instagram allows a limited number of API posts per 24 hours per account.
const checkPublishingLimit = async ({ igUserId, token, graph, gateKey }) => {
  const r = await graph({ path: `/${igUserId}/content_publishing_limit`, token, params: { fields: 'quota_usage,config' }, gateKey, retries: 2 });
  const row = r?.data?.[0];
  const used = Number(row?.quota_usage), total = Number(row?.config?.quota_total);
  if (Number.isFinite(used) && Number.isFinite(total) && used >= total) {
    throw new InstagramError(`This Instagram account has used its ${total} API posts for the last 24 hours. It will be retried later.`, { retryable: true });
  }
};

// media: [{ type, url }]. Returns { external_post_id, permalink }.
const publishToInstagram = async ({ igUserId, token, caption = '', media = [], graph = graphRequest, _sleep = sleep, pollMs }) => {
  if (!media.length) throw new InstagramError('Instagram needs a photo or video.');
  const gateKey = `ig:${igUserId}`;
  const post = (path, data) => graph({ path, method: 'POST', token, data, gateKey, retries: 2 });
  const wait = (id) => waitForContainer({ id, token, graph, gateKey, _sleep, ...(pollMs != null ? { pollMs } : {}) });

  await checkPublishingLimit({ igUserId, token, graph, gateKey });

  let containerId;
  if (media.length === 1) {
    const m = media[0];
    const body = m.type === 'video'
      ? { media_type: 'REELS', video_url: m.url, caption, share_to_feed: true }
      : { image_url: m.url, caption };
    containerId = (await post(`/${igUserId}/media`, body)).id;
  } else {
    const children = [];
    for (const m of media) {
      const body = m.type === 'video'
        ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true }
        : { image_url: m.url, is_carousel_item: true };
      const id = (await post(`/${igUserId}/media`, body)).id;
      await wait(id);
      children.push(id);
    }
    containerId = (await post(`/${igUserId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption })).id;
  }
  await wait(containerId);

  const published = await post(`/${igUserId}/media_publish`, { creation_id: containerId });
  let permalink = null;
  try { permalink = (await graph({ path: `/${published.id}`, token, params: { fields: 'permalink' }, gateKey, retries: 1 })).permalink || null; } catch { /* link is a nicety */ }
  return { external_post_id: String(published.id), permalink };
};

module.exports = { publishToInstagram, waitForContainer, checkPublishingLimit, InstagramError };
