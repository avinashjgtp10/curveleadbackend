const { query } = require('../config/db');
const { generateReviewRequestMessage } = require('../services/groqService');
const { DEFAULT_TEMPLATE } = require('../utils/googleReviewRequest');

const getSettings = async (tenantId) => {
  const r = await query('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
  return r.rows[0]?.settings || {};
};

const saveSettings = async (tenantId, patch) => {
  const current = await getSettings(tenantId);
  await query('UPDATE tenants SET settings = $1 WHERE id = $2', [JSON.stringify({ ...current, ...patch }), tenantId]);
};

// GET /api/gmb/settings
const getGmbSettings = async (req, res) => {
  try {
    const s = await getSettings(req.tenantId);
    res.json({
      enabled: !!s.google_review_request_enabled,
      review_link: s.google_review_link || '',
      message: s.google_review_request_message || DEFAULT_TEMPLATE,
    });
  } catch (e) { console.error('getGmbSettings:', e.message); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/gmb/settings
const updateGmbSettings = async (req, res) => {
  try {
    const { enabled, review_link, message } = req.body;
    const patch = {};
    if (enabled !== undefined) patch.google_review_request_enabled = !!enabled;
    if (review_link !== undefined) patch.google_review_link = String(review_link).trim().slice(0, 500);
    if (message !== undefined) patch.google_review_request_message = String(message).trim().slice(0, 1000);
    await saveSettings(req.tenantId, patch);
    res.json({ ok: true });
  } catch (e) { console.error('updateGmbSettings:', e.message); res.status(500).json({ error: 'Failed to save.' }); }
};

// POST /api/gmb/draft-message — AI drafts the review-request message from the
// business's own AI Auto-reply knowledge (tone/about), if any has been filled in.
const draftReviewMessage = async (req, res) => {
  try {
    const tenant = (await query('SELECT name, settings FROM tenants WHERE id = $1', [req.tenantId])).rows[0];
    const message = await generateReviewRequestMessage({
      businessName: tenant?.name,
      knowledge: tenant?.settings?.ai_knowledge,
    });
    res.json({ message });
  } catch (e) {
    console.error('draftReviewMessage:', e.message);
    res.status(502).json({ error: e.message || 'Failed to draft a message.' });
  }
};

module.exports = { getGmbSettings, updateGmbSettings, draftReviewMessage };
