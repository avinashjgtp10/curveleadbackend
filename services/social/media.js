const crypto = require('crypto');
const { uploadToS3, getPresignedUrl } = require('../../config/s3');

// Post media lives privately in S3 under social/{tenantId}/. Meta and Google download it
// from a pre-signed link created at publish time (D6), so the bucket never goes public.

const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;
const VIDEO_TYPES = /^video\/(mp4|quicktime)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const LINK_SECONDS = 24 * 60 * 60;

const fail = (status, message) => Object.assign(new Error(message), { status });

const s3Url = (key) => `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
const ownsKey = (tenantId, key) => typeof key === 'string' && key.startsWith(`social/${tenantId}/`) && !key.includes('..');

// Images become JPEG (Instagram accepts only JPEG), turned upright and at most 1440 px
// wide (Instagram's maximum). Videos are stored as uploaded.
const storeUpload = async ({ tenantId, file, sharp = require('sharp'), upload = uploadToS3 }) => {
  if (!file) throw fail(422, 'Choose a photo or video to upload.');
  const id = crypto.randomUUID();
  if (IMAGE_TYPES.test(file.mimetype)) {
    if (file.size > MAX_IMAGE_BYTES) throw fail(422, 'Photos can be up to 8 MB.');
    let out;
    try {
      out = await sharp(file.buffer).rotate().resize({ width: 1440, withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    } catch { throw fail(422, 'That image could not be read. Try a JPG or PNG.'); }
    const key = `social/${tenantId}/${id}.jpg`;
    await upload(out.data, key, 'image/jpeg');
    return { s3_key: key, type: 'image', mime: 'image/jpeg', width: out.info.width, height: out.info.height, size: out.info.size };
  }
  if (VIDEO_TYPES.test(file.mimetype)) {
    if (file.size > MAX_VIDEO_BYTES) throw fail(422, 'Videos can be up to 100 MB.');
    const ext = file.mimetype === 'video/quicktime' ? 'mov' : 'mp4';
    const key = `social/${tenantId}/${id}.${ext}`;
    await upload(file.buffer, key, file.mimetype);
    return { s3_key: key, type: 'video', mime: file.mimetype, size: file.size };
  }
  throw fail(422, 'Upload a JPG, PNG or WEBP photo, or an MP4 or MOV video.');
};

// Short-lived links for showing media in the app; 24 h links for platforms to fetch.
const signedUrl = (key, seconds = LINK_SECONDS, sign = getPresignedUrl) => sign(s3Url(key), seconds);
// A preview link that can't be made (S3 hiccup) shows a placeholder; it never fails the request.
const withPreviewUrls = async (media = [], sign = getPresignedUrl) =>
  Promise.all(media.map(async m => ({ ...m, preview_url: await signedUrl(m.s3_key, 3600, sign).catch(() => null) })));

module.exports = { storeUpload, signedUrl, withPreviewUrls, ownsKey, MAX_VIDEO_BYTES, LINK_SECONDS };
