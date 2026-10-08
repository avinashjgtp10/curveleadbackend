const { graphRequest } = require('../../utils/metaGraph');

// Publishes one post to a Facebook Page with the Page access token.
// media: [{ type, url }] where url is a pre-signed S3 link Meta downloads from (D6).
// Returns { external_post_id, permalink }.
const publishToFacebook = async ({ pageId, token, caption, link_url, media = [], graph = graphRequest }) => {
  const call = (path, data) => graph({ path, method: 'POST', token, data, gateKey: `page:${pageId}`, retries: 2 });
  const message = caption || undefined;
  let postId;

  if (!media.length) {
    const r = await call(`/${pageId}/feed`, { ...(message ? { message } : {}), ...(link_url ? { link: link_url } : {}) });
    postId = r.id;
  } else if (media[0].type === 'video') {
    const r = await call(`/${pageId}/videos`, { file_url: media[0].url, ...(message ? { description: message } : {}) });
    postId = r.post_id || r.id;
  } else if (media.length === 1) {
    const r = await call(`/${pageId}/photos`, { url: media[0].url, ...(message ? { caption: message } : {}) });
    postId = r.post_id || r.id;
  } else {
    // Several photos: upload each unpublished, then one feed post that attaches them all.
    const ids = [];
    for (const m of media) ids.push((await call(`/${pageId}/photos`, { url: m.url, published: false })).id);
    const attached = Object.fromEntries(ids.map((id, i) => [`attached_media[${i}]`, { media_fbid: id }]));
    const r = await call(`/${pageId}/feed`, { ...(message ? { message } : {}), ...attached });
    postId = r.id;
  }
  return { external_post_id: String(postId), permalink: `https://www.facebook.com/${postId}` };
};

module.exports = { publishToFacebook };
