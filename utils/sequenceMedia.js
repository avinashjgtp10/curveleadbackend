// Files a sequence step can attach: photos, documents and videos sent on WhatsApp.
// Limits follow what WhatsApp Cloud API accepts (images 5 MB, video 16 MB), with documents
// capped at 16 MB too so uploads stay in memory-friendly sizes.
const MB = 1024 * 1024;

const TYPES = {
  image: { exts: { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }, maxBytes: 5 * MB },
  video: { exts: { '.mp4': 'video/mp4', '.3gp': 'video/3gpp' }, maxBytes: 16 * MB },
  document: {
    exts: {
      '.pdf': 'application/pdf', '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.txt': 'text/plain',
    },
    maxBytes: 16 * MB,
  },
};
const MAX_UPLOAD_BYTES = 16 * MB;
const CAPTION_LIMIT = 1024; // WhatsApp's caption limit for image/video/document

const extOf = (name) => { const m = /\.[a-z0-9]+$/i.exec(String(name || '')); return m ? m[0].toLowerCase() : ''; };

// Classifies an upload by its extension. Returns { type, mime } or { error }.
const classifyUpload = (filename, size) => {
  const ext = extOf(filename);
  for (const [type, def] of Object.entries(TYPES)) {
    if (!def.exts[ext]) continue;
    if (size > def.maxBytes) return { error: `${type === 'image' ? 'Photos' : type === 'video' ? 'Videos' : 'Documents'} can be at most ${def.maxBytes / MB} MB on WhatsApp.` };
    return { type, mime: def.exts[ext] };
  }
  return { error: 'Use a photo (JPG, PNG), a video (MP4, 3GP) or a document (PDF, Word, Excel, PowerPoint, TXT).' };
};

// The S3 prefix a workspace's step attachments live under (also how ownership is checked).
const mediaPrefix = (tenantId) => `sequence-media/${tenantId}/`;

// Validates the `media` array on a step; returns an error string or null. A step carries at
// most one file: each step is one WhatsApp message, so more files means more steps.
const mediaError = (steps, tenantId) => {
  for (const [i, s] of (steps || []).entries()) {
    if (s?.media == null || (Array.isArray(s.media) && !s.media.length)) continue;
    const label = `Step ${i + 1}`;
    if (!Array.isArray(s.media) || s.media.length > 1) return `${label}: attach one file per step (add another step for more).`;
    if ((s.channel || 'whatsapp') !== 'whatsapp') return `${label}: files can only be sent on WhatsApp.`;
    if (s.always_template) return `${label}: "Always send approved template" can't carry a file. Use a template with a media header instead.`;
    const [m] = s.media;
    if (!m || typeof m.url !== 'string' || !m.url.includes(mediaPrefix(tenantId))) return `${label}: the attached file isn't from this workspace. Upload it again.`;
    if (!TYPES[m.type]) return `${label}: unsupported file type.`;
    if (!String(m.name || '').trim()) return `${label}: the attached file has no name.`;
    if ((s.message || '').length > CAPTION_LIMIT) return `${label}: with a file attached the message is its caption, at most ${CAPTION_LIMIT} characters.`;
  }
  return null;
};

// The attachment a step will send, or null. Tolerant of old rows (no media column / null).
const stepAttachment = (step) => (Array.isArray(step?.media) && step.media[0] && TYPES[step.media[0].type] ? step.media[0] : null);

// Type label for whatsappService.sendMediaMessage.
const sendKind = (type) => (type === 'document' ? 'doc' : type);

module.exports = { TYPES, MAX_UPLOAD_BYTES, CAPTION_LIMIT, classifyUpload, mediaPrefix, mediaError, stepAttachment, sendKind };
