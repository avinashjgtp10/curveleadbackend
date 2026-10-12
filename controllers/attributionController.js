const attribution = require('../services/attribution');

// Attribution API: view a lead's original and effective campaign, and make an audited correction.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (res, e) => {
  if (e instanceof attribution.AttributionError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error('Attribution error:', e && e.message);
  return res.status(500).json({ error: 'Failed. Please try again.' });
};

// GET /api/attribution/leads/:id
const get = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(422).json({ error: 'Invalid lead id.' });
    res.json(await attribution.getAttribution({ tenantId: req.tenantId, leadId: req.params.id }));
  } catch (e) { fail(res, e); }
};

// POST /api/attribution/leads/:id/correct { crm_campaign_id | null, reason }
const correct = async (req, res) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(422).json({ error: 'Invalid lead id.' });
    const b = req.body || {};
    if (b.crm_campaign_id != null && b.crm_campaign_id !== '' && !UUID.test(String(b.crm_campaign_id))) return res.status(422).json({ error: 'Invalid campaign id.' });
    res.json(await attribution.correct({ tenantId: req.tenantId, leadId: req.params.id, userId: req.user.id, crmCampaignId: b.crm_campaign_id || null, reason: b.reason }));
  } catch (e) { fail(res, e); }
};

module.exports = { get, correct };
