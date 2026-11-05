const { query: defaultQuery } = require('../../config/db');
// Structured log + durable audit row. Never throws: auditing must not break a call path. Never log secrets or full numbers.
const maskNumber = (n) => (n ? `${String(n).slice(0, 4)}****${String(n).slice(-2)}` : null);
const audit = async (db, { tenantId, actorId = null, action, entityId = null, detail = {} }) => {
  console.log(JSON.stringify({ evt: 'voice', action, tenantId, actorId, entityId, ...detail }));
  try {
    await (db || defaultQuery)('INSERT INTO voice_audit_logs (tenant_id, actor_id, action, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
      [tenantId, actorId, action, entityId, JSON.stringify(detail)]);
  } catch (e) { console.error('voice audit write failed:', e.message); }
};
module.exports = { audit, maskNumber };
