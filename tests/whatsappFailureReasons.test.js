// Failure reasons on Insights and Broadcasts. The database is MOCKED (no real queries); we check the shape and the fallbacks.
const test = require('node:test');
const assert = require('node:assert/strict');

const log = [];
let failureQueryError = null;
const db = require('../config/db');
db.query = async (sql) => {
  log.push(sql);
  if (/error_detail/.test(sql) && /GROUP BY 1, 2, 3, 4/.test(sql)) {
    if (failureQueryError) throw failureQueryError;
    return { rows: [
      { template_name: 'promo', sent_hour: '2026-11-05T10:00:00Z', sent_by_name: 'Asha', code: '131049', detail: '[131049] Meta chose not to deliver…', count: '3' },
      { template_name: 'promo', sent_hour: '2026-11-05T10:00:00Z', sent_by_name: 'Asha', code: null, detail: 'Recipient not valid', count: '1' },
    ] };
  }
  if (/error_detail/.test(sql)) {
    if (failureQueryError) throw failureQueryError;
    return { rows: [{ code: '131026', detail: "[131026] This number can't receive WhatsApp messages.", count: '5', templates: ['welcome_msg'] }, { code: null, detail: 'odd', count: '1', templates: null }] };
  }
  if (/GROUP BY m.template_name, sent_hour, u.name/.test(sql)) return { rows: [
    { template_name: 'promo', sent_hour: '2026-11-05T10:00:00Z', sent_by_name: 'Asha', total: '10', delivered: '5', read: '2', failed: '4', replied: '1' },
    { template_name: 'other', sent_hour: '2026-11-05T11:00:00Z', sent_by_name: null, total: '2', delivered: '2', read: '0', failed: '0', replied: '0' },
  ] };
  if (/PERCENTILE_CONT/.test(sql)) return { rows: [{ median_seconds: null }] };
  if (/DATE\(sent_at\)/.test(sql) || /GROUP BY m.template_name ORDER/.test(sql)) return { rows: [] };
  return { rows: [{ sent: '20', delivered: '10', read: '4', failed: '6', received: '2', ai_replies: '0', automated: '3', leads_replied: '1' }] };
};
const hub = require('../controllers/whatsappHubController');
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

test('Insights lists why messages failed, grouped by Meta code, with the templates involved', async () => {
  failureQueryError = null; const r = res();
  await hub.getAnalytics({ tenantId: 't1', query: { days: '30' } }, r);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.failure_reasons[0], { code: '131026', detail: "[131026] This number can't receive WhatsApp messages.", count: 5, templates: ['welcome_msg'] });
  assert.deepEqual(r.body.failure_reasons[1], { code: null, detail: 'odd', count: 1, templates: [] });
  assert.equal(r.body.totals.failed, 6);
});
test('each broadcast row carries its own failure reasons, and broadcasts without failures get none', async () => {
  failureQueryError = null; const r = res();
  await hub.getBroadcastHistory({ tenantId: 't1', query: {} }, r);
  const promo = r.body.broadcasts.find(b => b.template_name === 'promo');
  assert.deepEqual(promo.failure_reasons, [{ code: '131049', detail: '[131049] Meta chose not to deliver…', count: 3 }, { code: null, detail: 'Recipient not valid', count: 1 }]);
  assert.deepEqual(r.body.broadcasts.find(b => b.template_name === 'other').failure_reasons, []);
  assert.equal(promo.failed, 4);
});
test('an older database without the error_detail column still returns the page, just without reasons', async () => {
  failureQueryError = Object.assign(new Error('column "error_detail" does not exist'), { code: '42703' });
  const a = res(); await hub.getAnalytics({ tenantId: 't1', query: {} }, a);
  assert.equal(a.code, 200); assert.deepEqual(a.body.failure_reasons, []);
  const b = res(); await hub.getBroadcastHistory({ tenantId: 't1', query: {} }, b);
  assert.equal(b.code, 200); assert.ok(b.body.broadcasts.every(x => x.failure_reasons.length === 0));
  failureQueryError = Object.assign(new Error('boom'), { code: 'XX000' }); // any other error is still a real error
  const c = res(); await hub.getAnalytics({ tenantId: 't1', query: {} }, c);
  assert.equal(c.code, 500);
  failureQueryError = null;
});
