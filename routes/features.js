const router = require("express").Router();
const { query } = require("../config/db");
const { authenticate } = require("../middleware/auth");
const { tenantContext } = require("../middleware/tenant");
const { requirePermission } = require("../utils/permissions");
const features = require("../services/features");
const webhooks = require("../services/outgoingWebhooks");
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error("Feature request:", e.message);
    res
      .status(e.status || 500)
      .json({ error: e.status ? e.message : "Request failed." });
  }
};
router.get(
  "/content/:token",
  handle(async (req, res) => {
    if (!/^[a-f0-9]{48}$/.test(req.params.token))
      return res.status(404).send("Not found");
    const destination = await features.viewContent(req.params.token);
    if (!destination) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.redirect(destination);
  }),
);
router.use(authenticate, tenantContext);
router.get(
  "/health",
  handle(async (req, res) =>
    res.json({ integrations: await features.getHealth(req.tenantId) }),
  ),
);
router.get(
  "/canned-replies",
  handle(async (req, res) =>
    res.json({
      replies: (await features.getConfig(req.tenantId)).canned_replies,
    }),
  ),
);
router.use(requirePermission("settings.manage"));
router.get(
  "/config",
  handle(async (req, res) =>
    res.json({ config: await features.getConfig(req.tenantId) }),
  ),
);
router.put(
  "/config",
  handle(async (req, res) =>
    res.json({ config: await features.saveConfig(req.tenantId, req.body) }),
  ),
);
router.get(
  "/capi-events",
  handle(async (req, res) =>
    res.json({
      events: (
        await query(
          "SELECT id,lead_id,event_name,status,attempts,created_at FROM meta_capi_queue WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
          [req.tenantId],
        )
      ).rows,
    }),
  ),
);
router.get(
  "/webhooks",
  handle(async (req, res) =>
    res.json({
      webhooks: (
        await query(
          "SELECT id,url,events,active,created_at FROM outgoing_webhooks WHERE tenant_id=$1 ORDER BY created_at DESC",
          [req.tenantId],
        )
      ).rows,
    }),
  ),
);
router.post(
  "/webhooks",
  handle(async (req, res) =>
    res
      .status(201)
      .json({ webhook: await webhooks.createWebhook(req.tenantId, req.body) }),
  ),
);
router.delete(
  "/webhooks/:id",
  handle(async (req, res) => {
    await query(
      "UPDATE outgoing_webhooks SET active=false WHERE id=$1 AND tenant_id=$2",
      [req.params.id, req.tenantId],
    );
    res.json({ success: true });
  }),
);
router.get(
  "/deliveries",
  handle(async (req, res) =>
    res.json({
      deliveries: (
        await query(
          "SELECT id,webhook_id,event,status,attempts,response_code,error,created_at FROM webhook_deliveries WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
          [req.tenantId],
        )
      ).rows,
    }),
  ),
);
router.get(
  "/broadcasts",
  handle(async (req, res) =>
    res.json({
      broadcasts: (
        await query(
          `SELECT b.*,(b.failed+count(m.id) FILTER(WHERE m.status='failed' AND m.broadcast_sent))::int failed,count(m.id) FILTER(WHERE m.status IN ('delivered','read'))::int delivered,count(m.id) FILTER(WHERE m.status='read')::int read,count(DISTINCT m.lead_id) FILTER(WHERE EXISTS(SELECT 1 FROM whatsapp_messages i WHERE i.tenant_id=m.tenant_id AND i.lead_id=m.lead_id AND i.direction='inbound' AND i.sent_at>m.sent_at))::int replied FROM whatsapp_broadcast_reports b LEFT JOIN whatsapp_messages m ON m.broadcast_id=b.id AND m.tenant_id=b.tenant_id WHERE b.tenant_id=$1 GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`,
          [req.tenantId],
        )
      ).rows,
    }),
  ),
);
module.exports = router;
