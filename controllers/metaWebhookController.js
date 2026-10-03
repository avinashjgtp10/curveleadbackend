const queues = require('../jobs/queues');
const { tenantForPage } = require('../services/metaLeads');
const { webhookSecrets, verifyMetaWebhookAny } = require('../utils/metaWebhookSignature');

// GET /api/webhook/meta - Verify webhook
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
};

// POST /api/webhook/meta - Lead Ads webhook. Verifies Meta's signature, answers 200
// straight away and queues one leads:ingest-meta job per lead (every entry, not just
// the first — Meta batches several pages into one delivery).
const receiveLeadFormWebhook = async (req, res) => {
  const changes = (req.body?.entry || []).flatMap(e => (e.changes || []).filter(c => c.field === 'leadgen').map(c => c.value || {}));
  const secrets = webhookSecrets();
  if (!(secrets.length && verifyMetaWebhookAny(req.rawBody, req.headers['x-hub-signature-256'], secrets))) {
    // Lead details are always fetched from Meta with the page's own token, so an unsigned
    // payload can't inject a lead — it can only name a page. As with the WhatsApp webhook,
    // unsigned deliveries are accepted for connected pages (pages subscribed through
    // another Meta app) unless META_WEBHOOK_REQUIRE_SIGNATURE=true.
    const known = changes.length > 0 && (await Promise.all(changes.map(v => tenantForPage(v.page_id)))).every(Boolean);
    if (process.env.META_WEBHOOK_REQUIRE_SIGNATURE === 'true' || !known) {
      console.warn('Meta lead webhook rejected: invalid signature.');
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }
    console.warn('Meta lead webhook accepted without a verified signature for page(s)', [...new Set(changes.map(v => v.page_id))].join(','));
  }
  res.sendStatus(200);
  for (const v of changes) {
    if (!v.leadgen_id || !v.page_id) continue;
    await queues.enqueue('leads:ingest-meta', { pageId: String(v.page_id), leadgenId: String(v.leadgen_id) }, { jobId: `meta-lead-${v.leadgen_id}` })
      .catch(e => console.error('Could not queue Meta lead', v.leadgen_id, e.message));
  }
};

module.exports = { verifyWebhook, receiveLeadFormWebhook };
