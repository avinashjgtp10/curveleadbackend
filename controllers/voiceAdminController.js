const { services } = require('../services/voiceCalling');
const { audit } = require('../services/voiceCalling/audit');

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('Voice admin error:', e.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
};

exports.policies = handle(async (req, res) => res.json(await services().admin.policies()));
exports.overview = handle(async (req, res) => res.json(await services().admin.overview(req.params.tenantId)));
exports.upsertAccount = handle(async (req, res) => res.json(await services().admin.upsertAccount({ adminId: req.user.id, tenantId: req.params.tenantId, body: req.body || {} })));
exports.addNumber = handle(async (req, res) => res.status(201).json(await services().admin.addNumber({ adminId: req.user.id, tenantId: req.params.tenantId, body: req.body || {} })));
exports.updateNumber = handle(async (req, res) => res.json(await services().admin.updateNumber({ adminId: req.user.id, numberId: req.params.id, body: req.body || {} })));
exports.addRate = handle(async (req, res) => res.status(201).json(await services().admin.addRate({ adminId: req.user.id, body: req.body || {} })));

exports.setRoute = handle(async (req, res) => {
  const { originCountry: o, destinationCountry: d, enabled, notes } = req.body || {};
  if (!/^[A-Z]{2}$/.test(o || '') || !/^[A-Z]{2}$/.test(d || '') || typeof enabled !== 'boolean') return res.status(400).json({ error: 'originCountry, destinationCountry (ISO alpha-2) and enabled are required.' });
  const row = await services().policies.setRouteEnabled({ originCountry: o, destinationCountry: d, enabled, adminId: req.user.id, notes });
  if (!row) return res.status(404).json({ error: 'No such policy row.' });
  await audit(null, { tenantId: null, actorId: req.user.id, action: enabled ? 'policy.enabled' : 'policy.disabled', entityId: `${o}>${d}`, detail: { notes } });
  res.json(row);
});
