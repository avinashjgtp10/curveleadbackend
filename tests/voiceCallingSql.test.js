// CurveLead Voice against real PostgreSQL in a throwaway schema. SKIPPED unless VOICE_TEST_DATABASE_URL points at an
// isolated local database (it creates and drops its own schema). Provider is a fake: no real calls are ever placed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const url = process.env.VOICE_TEST_DATABASE_URL;
const skip = !url && 'set VOICE_TEST_DATABASE_URL (isolated local database) to run';

const SCHEMA = `vt_${crypto.randomBytes(4).toString('hex')}`;
let pool; let svc; let fx; let providerLog; let nextEvent;

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'models', f), 'utf8');

test.before(async () => {
  if (skip) return;
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${SCHEMA}`); await admin.end();
  pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA},public` });
  await pool.query(read('schema.sql')); await pool.query(read('migration_voice_calling.sql'));
  await pool.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_name TEXT'); // not needed by voice, harmless

  const query = (t, p) => pool.query(t, p);
  const transaction = async (fn) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } };
  providerLog = [];
  const fakeProvider = {
    id: 'telnyx', implemented: true, capabilities: { clientToken: true, serverDial: true, hangup: true },
    initiateCall: async (i) => { providerLog.push(['dial', i]); if (fx.failDial) throw new (require('../services/voiceCalling/providers/contract').ProviderError)('down', { retryable: true, status: fx.capacityDial ? 403 : 503, capacity: !!fx.capacityDial }); return { providerCallId: `cc-${i.commandId}`, providerSessionId: 's' }; },
    hangupCall: async (i) => { providerLog.push(['hangup', i]); },
    createClientToken: async () => ({ token: 't', credentialId: 'c' }), getCallDetails: async () => ({}),
    verifyWebhook: ({ rawBody }) => { const e = JSON.parse(rawBody.toString()); return { ...e, occurredAt: e.occurredAt && new Date(e.occurredAt), detail: { startTime: e.detail?.startTime && new Date(e.detail.startTime), endTime: e.detail?.endTime && new Date(e.detail.endTime), hangupCause: e.detail?.hangupCause || null } }; },
  };
  const getProvider = () => fakeProvider;
  const hasPermission = async (u, k) => (u.role === 'admin' ? true : (u.perms || []).includes(k));
  const { createWalletService } = require('../services/voiceCalling/wallet');
  const { createRateService } = require('../services/voiceCalling/rates');
  const { createCountryPolicyService } = require('../services/voiceCalling/countryPolicy');
  const { createCallService } = require('../services/voiceCalling/calls');
  const { createWebhookService } = require('../services/voiceCalling/webhooks');
  const wallet = createWalletService({ query, transaction });
  const common = { query, transaction, getProvider, wallet, hasPermission, rates: createRateService({ query }), policies: createCountryPolicyService({ query }) };
  svc = { query, transaction, wallet, calls: createCallService(common), webhooks: createWebhookService({ query, transaction, getProvider, wallet }), createCallService, common };

  // Fixtures: tenant A (fully set up) and tenant B (isolation target).
  const mk = async (name) => (await query(`INSERT INTO tenants (name, slug, settings) VALUES ($1,$2,'{"country":"IN"}') RETURNING id`, [name, `${name}-${crypto.randomBytes(3).toString('hex')}`])).rows[0].id;
  const A = await mk('a'); const B = await mk('b');
  const user = async (t, role, n) => (await query(`INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,'x',$4) RETURNING id, role, tenant_id`, [t, n, `${n}-${crypto.randomBytes(3).toString('hex')}@t.co`, role])).rows[0];
  const admin1 = await user(A, 'admin', 'adm'); const staff = await user(A, 'staff', 'stf'); const adminB = await user(B, 'admin', 'admb');
  const lead = async (t, assigned, phone) => (await query(`INSERT INTO leads (tenant_id, name, phone, assigned_to) VALUES ($1,'Lead',$2,$3) RETURNING id`, [t, phone, assigned])).rows[0].id;
  fx = { A, B, admin1, staff: { ...staff, perms: ['voice.call'] }, staffNoPerm: staff, adminB, failDial: false,
    leadAdmin: await lead(A, admin1.id, '+919665624277'), leadStaff: await lead(A, staff.id, '+919665624277'), leadB: await lead(B, null, '+919665624277') };
  await query(`INSERT INTO voice_accounts (tenant_id, provider, provider_account_reference, status, business_verification_status, allowed_destination_countries)
               VALUES ($1,'telnyx','conn','active','verified','{IN}')`, [A]);
  await query(`INSERT INTO voice_phone_numbers (tenant_id, provider, phone_number_e164, country_code, verification_status) VALUES ($1,'telnyx','+911140000000','IN','verified')`, [A]);
  await query(`INSERT INTO voice_rate_cards (provider, destination_country, destination_prefix, cost_per_minute_micro, selling_price_per_minute_micro, currency) VALUES ('telnyx','IN','91',1000000,1500000,'INR')`);
  await query(`INSERT INTO voice_wallets (tenant_id, currency, available_balance) VALUES ($1,'INR',100000)`, [A]);
  nextEvent = 0;
});
test.after(async () => { if (skip) return; await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`).catch(() => {}); await pool.end(); });

const enableRoute = (on = true) => pool.query(`UPDATE voice_country_policies SET enabled=$1, requires_contact_consent=false, calling_hours_start='00:00', calling_hours_end='23:59' WHERE origin_country='IN' AND destination_country='IN'`, [on]);
const wal = async () => (await pool.query('SELECT available_balance::text a, reserved_balance::text r FROM voice_wallets WHERE tenant_id=$1', [fx.A])).rows[0];
const reset = async () => { await pool.query('DELETE FROM voice_calls'); await pool.query('UPDATE voice_wallets SET available_balance=100000, reserved_balance=0'); await pool.query('DELETE FROM voice_wallet_transactions'); };
const evt = (call, type, extra = {}) => ({ rawBody: Buffer.from(JSON.stringify({ providerEventId: `e${++nextEvent}`, type, rawType: `call.${type}`, occurredAt: extra.at, providerCallId: `cc-${call}`, providerSessionId: 's',
  clientState: svc.calls.encodeState({ c: call, t: fx.A }), detail: extra.detail || {}, payload: { data: { payload: extra.payload || {} } } })), headers: {} });
const auth = (u = fx.admin1, leadId = fx.leadAdmin) => svc.calls.authorize({ user: u, tenantId: fx.A, originCountry: 'IN', leadId });

test('routes are disabled by default: nothing can be authorized and the wallet is untouched', { skip }, async () => {
  await reset();
  await assert.rejects(auth(), (e) => e.code === 'ROUTE_DISABLED' && e.status === 403);
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
  assert.equal((await pool.query(`SELECT enabled FROM voice_country_policies WHERE enabled`)).rowCount, 0);
});

test('authorize reserves funds; cancel/expiry release exactly once', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth();
  assert.equal(a.callerId, '+911140000000'); assert.equal(a.destination.country, 'IN');
  const w = await wal(); assert.equal(w.r, String(BigInt(w.r))); assert.ok(BigInt(w.r) > 0n); assert.equal(BigInt(w.a) + BigInt(w.r), 100000n);
  assert.equal((await svc.calls.cancelAuthorization({ callId: a.authorizationId, tenantId: fx.A })), true);
  assert.equal((await svc.calls.cancelAuthorization({ callId: a.authorizationId, tenantId: fx.A })), false);
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
  const b = await auth();
  await pool.query(`UPDATE voice_calls SET authorization_expires_at = NOW() - INTERVAL '1 second' WHERE id=$1`, [b.authorizationId]);
  await svc.calls.expireStale(); await svc.calls.expireStale();
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
});

test('concurrent authorizations can never reserve more than the balance', { skip }, async () => {
  await reset(); await enableRoute();
  await pool.query(`UPDATE voice_wallets SET available_balance=1000`); // ~ 40 min total at 1.50/min; each wants up to 15 min (=2250) -> affordable 6 min (900)
  const users = [fx.admin1]; // same agent: reservation, not live-call, is what is contended
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => auth(users[0])));
  const w = await wal();
  assert.ok(BigInt(w.a) >= 0n, 'available never negative'); assert.equal(BigInt(w.a) + BigInt(w.r), 1000n);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected');
  assert.ok(ok >= 1 && failed.length >= 1); assert.ok(failed.every(f => f.reason.code === 'INSUFFICIENT_BALANCE'));
  const sum = (await pool.query(`SELECT COALESCE(SUM(reserved_amount),0)::text s FROM voice_calls`)).rows[0].s;
  assert.equal(sum, w.r, 'per-call reservations add up to the wallet reservation');
});

test('full lifecycle: claim, answered, hangup settles once; duplicate and replayed webhooks are no-ops', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth();
  const claim = await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  assert.equal(claim.dial.to, '+919665624277');
  // second initiate of same authorization is idempotent, not a second claim
  assert.equal((await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId })).status, 'initiating');
  const id = a.authorizationId;
  await svc.webhooks.handle(evt(id, 'ringing', { at: '2026-06-01T10:00:00Z' }));
  const ans = evt(id, 'answered', { at: '2026-06-01T10:00:10Z' });
  await svc.webhooks.handle(ans);
  assert.deepEqual(await svc.webhooks.handle(ans), { handled: true, duplicate: true });
  const hang = evt(id, 'hangup', { at: '2026-06-01T10:02:15Z', detail: { endTime: '2026-06-01T10:02:15Z', hangupCause: 'normal_clearing' } });
  await svc.webhooks.handle(hang); await svc.webhooks.handle(hang);
  const c = (await pool.query(`SELECT status, duration_seconds, billable_seconds, customer_cost::text cc, provider_cost::text pc, reserved_amount::text ra FROM voice_calls WHERE id=$1`, [id])).rows[0];
  assert.equal(c.status, 'completed'); assert.equal(c.duration_seconds, 125); // 2m05 -> bills 3 min
  assert.equal(c.cc, '450'); assert.equal(c.pc, '300'); assert.equal(c.ra, '0');
  assert.deepEqual(await wal(), { a: String(100000 - 450), r: '0' });
  assert.equal((await pool.query(`SELECT 1 FROM voice_wallet_transactions WHERE call_id=$1 AND transaction_type='debit'`, [id])).rowCount, 1);
  const act = await pool.query(`SELECT metadata FROM lead_activities WHERE lead_id=$1 AND activity_type='call'`, [fx.leadAdmin]);
  assert.equal(act.rowCount, 1); assert.equal(act.rows[0].metadata.voice_call_id, id);
  // a replay with a NEW event id after settlement must not charge again
  await svc.webhooks.handle(evt(id, 'hangup', { at: '2026-06-01T10:02:20Z', detail: { endTime: '2026-06-01T10:02:20Z' } }));
  assert.deepEqual(await wal(), { a: String(100000 - 450), r: '0' });
});

test('out-of-order: hangup before answered is corrected by the late answered event, charged once', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId }); const id = a.authorizationId;
  await svc.webhooks.handle(evt(id, 'hangup', { at: '2026-06-01T10:01:00Z', detail: { endTime: '2026-06-01T10:01:00Z', hangupCause: 'normal_clearing' } }));
  assert.equal((await pool.query(`SELECT status FROM voice_calls WHERE id=$1`, [id])).rows[0].status, 'failed'); // provisional: never seen answered
  await svc.webhooks.handle(evt(id, 'answered', { at: '2026-06-01T10:00:00Z' }));
  const c = (await pool.query(`SELECT status, billable_seconds, customer_cost::text cc FROM voice_calls WHERE id=$1`, [id])).rows[0];
  assert.equal(c.status, 'completed'); assert.equal(c.billable_seconds, 60); assert.equal(c.cc, '150');
  assert.deepEqual(await wal(), { a: String(100000 - 150), r: '0' });
});

test('a call that never connects costs nothing and releases the reservation', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  await svc.webhooks.handle(evt(a.authorizationId, 'hangup', { at: '2026-06-01T10:00:30Z', detail: { endTime: '2026-06-01T10:00:30Z', hangupCause: 'no_answer' } }));
  assert.equal((await pool.query(`SELECT status, customer_cost::text cc FROM voice_calls WHERE id=$1`, [a.authorizationId])).rows[0].cc, '0');
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
});

test('billing is capped at the authorized duration plus grace', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  await svc.webhooks.handle(evt(a.authorizationId, 'answered', { at: '2026-06-01T10:00:00Z' }));
  await svc.webhooks.handle(evt(a.authorizationId, 'hangup', { at: '2026-06-01T12:00:00Z', detail: { endTime: '2026-06-01T12:00:00Z' } })); // 2h
  const c = (await pool.query(`SELECT billable_seconds, max_duration_seconds FROM voice_calls WHERE id=$1`, [a.authorizationId])).rows[0];
  assert.equal(c.billable_seconds, c.max_duration_seconds + 10);
});

test('a webhook for a number other than the authorized one hangs the call up and flags it', { skip }, async () => {
  await reset(); await enableRoute(); providerLog.length = 0;
  const a = await auth(); await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  const r = await svc.webhooks.handle(evt(a.authorizationId, 'initiated', { payload: { to: '+971500000000' } }));
  assert.equal(r.rejected, 'destination_mismatch'); assert.ok(providerLog.some(([k]) => k === 'hangup'));
});

test('server-mode setup failure releases the reservation and frees the agent', { skip }, async () => {
  await reset(); await enableRoute(); fx.failDial = true;
  const a = await auth();
  await assert.rejects(svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId, mode: 'server' }), (e) => e.code === 'PROVIDER_ERROR');
  fx.failDial = false;
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
  const b = await auth(); // agent is not stuck
  assert.equal((await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: b.authorizationId })).status, 'initiating');
});

test('an agent cannot hold two live calls (web + mobile cannot both claim)', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); const b = await auth();
  await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  await assert.rejects(svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: b.authorizationId }), (e) => e.code === 'AGENT_BUSY');
});

test('expired authorizations cannot be claimed', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth();
  await pool.query(`UPDATE voice_calls SET authorization_expires_at = NOW() - INTERVAL '1 second' WHERE id=$1`, [a.authorizationId]);
  await assert.rejects(svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId }), (e) => e.code === 'AUTH_EXPIRED');
});

test('permissions, ownership and tenant isolation', { skip }, async () => {
  await reset(); await enableRoute();
  await assert.rejects(auth(fx.staffNoPerm, fx.leadStaff), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(auth(fx.staff, fx.leadAdmin), (e) => e.code === 'LEAD_NOT_OWNED');
  const ok = await auth(fx.staff, fx.leadStaff); assert.ok(ok.authorizationId);
  await assert.rejects(svc.calls.authorize({ user: fx.admin1, tenantId: fx.A, originCountry: 'IN', leadId: fx.leadB }), (e) => e.code === 'LEAD_NOT_FOUND'); // other tenant's lead
  // tenant B can neither read, hang up, nor claim tenant A's call
  await assert.rejects(svc.calls.get({ user: fx.adminB, tenantId: fx.B, callId: ok.authorizationId }), (e) => e.status === 404);
  assert.equal((await svc.calls.list({ user: fx.adminB, tenantId: fx.B })).length, 0);
  await assert.rejects(svc.calls.hangup({ user: fx.adminB, tenantId: fx.B, callId: ok.authorizationId }), (e) => e.status === 404);
  await assert.rejects(svc.calls.initiate({ user: fx.adminB, tenantId: fx.B, authorizationId: ok.authorizationId }), (e) => e.status === 404);
  // a staff member only sees their own calls
  assert.equal((await svc.calls.list({ user: fx.staff, tenantId: fx.A })).length, 1);
});

test('unverified caller IDs, missing rates and low balance are refused', { skip }, async () => {
  await reset(); await enableRoute();
  await pool.query(`UPDATE voice_phone_numbers SET verification_status='pending'`);
  await assert.rejects(auth(), (e) => e.code === 'NO_VERIFIED_CALLER_ID');
  await pool.query(`UPDATE voice_phone_numbers SET verification_status='verified'`);
  await pool.query(`UPDATE voice_rate_cards SET effective_to = NOW() - INTERVAL '1 day'`);
  await assert.rejects(auth(), (e) => e.code === 'NO_RATE');
  await pool.query(`UPDATE voice_rate_cards SET effective_to = NULL`);
  await pool.query(`UPDATE voice_wallets SET available_balance=10`);
  await assert.rejects(auth(), (e) => e.code === 'INSUFFICIENT_BALANCE');
});

test('top-ups need a confirmed payment id and are idempotent per payment', { skip }, async () => {
  await reset();
  await assert.rejects(svc.wallet.topUp({ tenantId: fx.A, currency: 'INR', amountMinor: 500 }), (e) => e.code === 'PAYMENT_NOT_CONFIRMED');
  assert.equal((await svc.wallet.topUp({ tenantId: fx.A, currency: 'INR', amountMinor: 500, confirmedPaymentId: 'pay_1' })).applied, true);
  assert.equal((await svc.wallet.topUp({ tenantId: fx.A, currency: 'INR', amountMinor: 500, confirmedPaymentId: 'pay_1' })).applied, false);
  assert.deepEqual(await wal(), { a: '100500', r: '0' });
});

test('stale live calls are released by the sweeper and flagged', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  await pool.query(`UPDATE voice_calls SET updated_at = NOW() - INTERVAL '5 minutes' WHERE id=$1`, [a.authorizationId]);
  const out = await svc.calls.expireStale();
  assert.equal(out.abandoned, 1);
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
});

// ---- wallet recharge (Razorpay) ----------------------------------------------------------------
const rzp = (payment, orderId = 'order_1') => ({
  orders: { create: async () => ({ id: orderId }) },
  payments: { fetch: async () => payment },
});
const topups = (gateway) => require('../services/voiceCalling/topups').createTopupService({ query: svc.query, wallet: svc.wallet, gateway, keySecret: 'sec', keyId: 'rzp_test' });
const sig = (o, p) => crypto.createHmac('sha256', 'sec').update(`${o}|${p}`).digest('hex');

test('recharge: order bounds are enforced and the wallet is untouched until the gateway confirms capture', { skip }, async () => {
  await reset(); await pool.query('DELETE FROM voice_topup_orders');
  const t = topups(rzp({ order_id: 'order_1', status: 'authorized', amount: 50000, currency: 'INR' }));
  await assert.rejects(t.createOrder({ user: fx.admin1, tenantId: fx.A, amountMinor: 5 }), (e) => e.code === 'BAD_AMOUNT');
  await assert.rejects(t.createOrder({ user: fx.admin1, tenantId: fx.A, amountMinor: 'abc' }), (e) => e.code === 'BAD_AMOUNT');
  const o = await t.createOrder({ user: fx.admin1, tenantId: fx.A, amountMinor: 50000 });
  assert.equal(o.orderId, 'order_1'); assert.equal(o.currency, 'INR'); assert.equal(o.keyId, 'rzp_test');
  await assert.rejects(t.verify({ tenantId: fx.A, orderId: 'order_1', paymentId: 'pay_1', signature: 'forged' }), (e) => e.code === 'BAD_SIGNATURE');
  assert.deepEqual(await t.verify({ tenantId: fx.A, orderId: 'order_1', paymentId: 'pay_1', signature: sig('order_1', 'pay_1') }), { result: 'pending' }); // authorized, not captured
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
});

test('recharge: captured payment credits exactly once; replays, webhooks and other tenants cannot double-credit', { skip }, async () => {
  await reset(); await pool.query('DELETE FROM voice_topup_orders');
  const good = rzp({ order_id: 'order_2', status: 'captured', amount: 25000, currency: 'INR' }, 'order_2');
  const t = topups(good);
  await t.createOrder({ user: fx.admin1, tenantId: fx.A, amountMinor: 25000 });
  await assert.rejects(t.verify({ tenantId: fx.B, orderId: 'order_2', paymentId: 'pay_2', signature: sig('order_2', 'pay_2') }), (e) => e.status === 404); // someone else's order
  assert.deepEqual(await t.verify({ tenantId: fx.A, orderId: 'order_2', paymentId: 'pay_2', signature: sig('order_2', 'pay_2') }), { result: 'credited' });
  assert.deepEqual(await t.verify({ tenantId: fx.A, orderId: 'order_2', paymentId: 'pay_2', signature: sig('order_2', 'pay_2') }), { result: 'already' });
  assert.equal(await t.handleWebhookEvent({ payload: { payment: { entity: { id: 'pay_2', order_id: 'order_2' } } } }), true);
  assert.equal(await t.handleWebhookEvent({ payload: { payment: { entity: { id: 'pay_x', order_id: 'order_unrelated' } } } }), false); // subscription/other payments ignored
  assert.deepEqual(await wal(), { a: '125000', r: '0' });
  assert.equal((await pool.query(`SELECT status FROM voice_topup_orders WHERE razorpay_order_id='order_2'`)).rows[0].status, 'paid');
});

test('recharge: a payment for a different amount or another order is rejected and never credited', { skip }, async () => {
  await reset(); await pool.query('DELETE FROM voice_topup_orders');
  const t = topups(rzp({ order_id: 'order_3', status: 'captured', amount: 100, currency: 'INR' }, 'order_3'));
  await t.createOrder({ user: fx.admin1, tenantId: fx.A, amountMinor: 20000 });
  await assert.rejects(t.verify({ tenantId: fx.A, orderId: 'order_3', paymentId: 'p', signature: sig('order_3', 'p') }), (e) => e.code === 'AMOUNT_MISMATCH');
  const wrongOrder = topups(rzp({ order_id: 'order_OTHER', status: 'captured', amount: 20000, currency: 'INR' }, 'order_3'));
  await assert.rejects(wrongOrder.verify({ tenantId: fx.A, orderId: 'order_3', paymentId: 'p', signature: sig('order_3', 'p') }), (e) => e.code === 'ORDER_MISMATCH');
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
});

// ---- platform admin setup ----------------------------------------------------------------------
test('admin: creating an account enables no country; activation needs a connection id; inputs are validated', { skip }, async () => {
  const admin = require('../services/voiceCalling/admin').createAdminService({ query: svc.query });
  const T = (await pool.query(`INSERT INTO tenants (name, slug, settings) VALUES ('c', $1, '{"country":"AE"}') RETURNING id`, [`c-${crypto.randomBytes(3).toString('hex')}`])).rows[0].id;
  await assert.rejects(admin.upsertAccount({ adminId: fx.admin1.id, tenantId: T, body: { status: 'active' } }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(admin.upsertAccount({ adminId: fx.admin1.id, tenantId: T, body: { allowedDestinationCountries: ['india'] } }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(admin.upsertAccount({ adminId: fx.admin1.id, tenantId: T, body: { provider: 'twilio' } }), (e) => e.code === 'BAD_INPUT');
  await assert.rejects(admin.upsertAccount({ adminId: fx.admin1.id, tenantId: '00000000-0000-0000-0000-000000000000', body: {} }), (e) => e.status === 404);
  const a = await admin.upsertAccount({ adminId: fx.admin1.id, tenantId: T, body: { providerAccountReference: 'conn-9', allowedDestinationCountries: ['AE'], defaultCurrency: 'AED' } });
  assert.equal(a.status, 'pending'); assert.equal(a.business_verification_status, 'unverified'); assert.equal(a.recording_enabled, false);
  assert.equal((await pool.query(`SELECT 1 FROM voice_wallets WHERE tenant_id=$1 AND currency='AED'`, [T])).rowCount, 1);
  assert.equal((await pool.query(`SELECT 1 FROM voice_country_policies WHERE enabled AND origin_country='AE'`)).rowCount, 0); // nothing enabled for the new org's country
  const o = await admin.overview(T); assert.equal(o.organizationCountry, 'AE'); assert.equal(o.account.default_currency, 'AED');
});

test('admin: caller IDs are validated, unique, tenant-bound, and verification is attributed', { skip }, async () => {
  const admin = require('../services/voiceCalling/admin').createAdminService({ query: svc.query });
  await assert.rejects(admin.addNumber({ adminId: fx.admin1.id, tenantId: fx.A, body: { phoneNumber: '12345' } }), (e) => e.code === 'BAD_INPUT');
  const n = await admin.addNumber({ adminId: fx.admin1.id, tenantId: fx.A, body: { phoneNumber: '+65 6123 4567' } });
  assert.equal(n.verification_status, 'pending'); assert.equal(n.country_code, 'SG');
  await assert.rejects(admin.addNumber({ adminId: fx.admin1.id, tenantId: fx.B, body: { phoneNumber: '+6561234567' } }), (e) => e.code === 'DUPLICATE');
  await assert.rejects(admin.updateNumber({ adminId: fx.admin1.id, numberId: n.id, body: { assignedAgentId: fx.adminB.id } }), (e) => e.code === 'BAD_INPUT'); // agent from another org
  const v = await admin.updateNumber({ adminId: fx.admin1.id, numberId: n.id, body: { verificationStatus: 'verified', assignedAgentId: fx.staff.id } });
  assert.equal(v.verification_status, 'verified'); assert.equal(v.assigned_agent_id, fx.staff.id);
  const row = (await pool.query('SELECT verified_by FROM voice_phone_numbers WHERE id=$1', [n.id])).rows[0]; assert.equal(row.verified_by, fx.admin1.id);
  await pool.query('DELETE FROM voice_phone_numbers WHERE id=$1', [n.id]);
});

test('admin: rates derive selling price from markup, refuse below-cost, and supersede the previous rate', { skip }, async () => {
  const admin = require('../services/voiceCalling/admin').createAdminService({ query: svc.query });
  const base = { destinationCountry: 'SG', destinationPrefix: '65', currency: 'INR', costPerMinuteMicro: '2000000' };
  await assert.rejects(admin.addRate({ adminId: fx.admin1.id, body: { ...base, sellingPricePerMinuteMicro: '1000000' } }), (e) => e.code === 'BELOW_COST');
  await assert.rejects(admin.addRate({ adminId: fx.admin1.id, body: { ...base, destinationPrefix: '+65', markupBps: 1000 } }), (e) => e.code === 'BAD_INPUT');
  const r1 = await admin.addRate({ adminId: fx.admin1.id, body: { ...base, markupBps: 2000 } });
  assert.equal(r1.sellingPricePerMinuteMicro, '2400000');
  const r2 = await admin.addRate({ adminId: fx.admin1.id, body: { ...base, markupBps: 3000 } });
  const live = (await pool.query(`SELECT id, selling_price_per_minute_micro::text s FROM voice_rate_cards WHERE destination_country='SG' AND destination_prefix='65' AND effective_to IS NULL`)).rows;
  assert.equal(live.length, 1); assert.equal(live[0].id, r2.id); assert.equal(live[0].s, '2600000');
});

// ---- caller ID selection & UAE hours migration --------------------------------------------------
test('one US caller ID serves every destination; a destination-matching number takes over later with no API change', { skip }, async () => {
  await reset(); await enableRoute();
  await pool.query(`UPDATE voice_phone_numbers SET verification_status='revoked'`); // start clean: only the US number below is usable
  await pool.query(`INSERT INTO voice_phone_numbers (tenant_id, provider, phone_number_e164, country_code, verification_status) VALUES ($1,'telnyx','+15673603199','US','verified')`, [fx.A]);
  assert.equal((await auth()).callerId, '+15673603199');                        // US number for an Indian lead
  await pool.query(`UPDATE voice_phone_numbers SET verification_status='verified' WHERE phone_number_e164='+911140000000'`); // an India number appears
  assert.equal((await auth()).callerId, '+911140000000');                       // preferred for +91, same response shape
  await pool.query(`UPDATE voice_phone_numbers SET assigned_agent_id=$1 WHERE phone_number_e164='+15673603199'`, [fx.admin1.id]);
  assert.equal((await auth()).callerId, '+15673603199');                        // an agent-assigned number still wins
  await pool.query(`UPDATE voice_phone_numbers SET assigned_agent_id=NULL WHERE phone_number_e164='+15673603199'`);
  await pool.query(`UPDATE voice_phone_numbers SET assigned_agent_id=$1 WHERE phone_number_e164='+911140000000'`, [fx.staff.id]);
  await pool.query(`UPDATE voice_phone_numbers SET verification_status='revoked' WHERE phone_number_e164='+15673603199'`);
  await assert.rejects(auth(), (e) => e.code === 'NO_VERIFIED_CALLER_ID');      // never another agent's number
  await pool.query(`UPDATE voice_phone_numbers SET assigned_agent_id=NULL, verification_status='verified' WHERE phone_number_e164='+911140000000'`);
  await pool.query(`DELETE FROM voice_phone_numbers WHERE phone_number_e164='+15673603199'`);
});

test('UAE hours migration narrows stored policy rows to 09:00-18:00 and is idempotent', { skip }, async () => {
  await pool.query(`UPDATE voice_country_policies SET calling_hours_start='06:00', calling_hours_end='23:00' WHERE destination_country='AE' AND origin_country='IN'`);
  await pool.query(`UPDATE voice_country_policies SET calling_hours_start='10:00', calling_hours_end='16:00' WHERE destination_country='AE' AND origin_country='SG'`);
  const sql = read('migration_voice_uae_hours.sql');
  await pool.query(sql); await pool.query(sql);
  const r = (await pool.query(`SELECT origin_country o, calling_hours_start::text s, calling_hours_end::text e FROM voice_country_policies WHERE destination_country='AE' ORDER BY origin_country`)).rows;
  const by = Object.fromEntries(r.map((x) => [x.o, x]));
  assert.deepEqual([by.IN.s, by.IN.e], ['09:00:00', '18:00:00']);               // widened rows are pulled in
  assert.deepEqual([by.SG.s, by.SG.e], ['10:00:00', '16:00:00']);               // stricter rows are left alone
  assert.equal((await pool.query(`SELECT 1 FROM voice_country_policies WHERE destination_country<>'AE' AND calling_hours_end > '18:00' LIMIT 1`)).rowCount, 1); // other countries untouched
});

// ---- account-wide concurrency (Telnyx allows 2 live outbound calls for the whole account) ------------
const extraAgents = async (n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await pool.query(`INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES ($1,$2,$3,'x','admin') RETURNING id, role, tenant_id`,
    [fx.A, `cap${i}`, `cap${i}-${crypto.randomBytes(3).toString('hex')}@t.co`])).rows[0]);
  return out;
};

test('account-wide limit: with 4 agents racing for 2 lines exactly 2 claims succeed and the rest get a clear message', { skip }, async () => {
  await reset(); await enableRoute(); delete process.env.VOICE_MAX_CONCURRENT_CALLS; // default limit = 2
  const agents = await extraAgents(4);
  const auths = await Promise.all(agents.map((u) => auth(u)));
  const results = await Promise.allSettled(agents.map((u, i) => svc.calls.initiate({ user: u, tenantId: fx.A, authorizationId: auths[i].authorizationId })));
  const ok = results.filter((r) => r.status === 'fulfilled'); const no = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 2); assert.equal(no.length, 2);
  for (const r of no) { assert.equal(r.reason.status, 503); assert.equal(r.reason.code, 'PROVIDER_ERROR'); assert.match(r.reason.message, /lines are busy/); } // existing code, no new one
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM voice_calls WHERE status='initiating'`)).rows[0].n, 2);

  // The winner retrying is idempotent (not counted against itself); a loser's authorization is still valid and unreserved changes nothing.
  const winnerIdx = results.findIndex((r) => r.status === 'fulfilled'); const loserIdx = results.findIndex((r) => r.status === 'rejected');
  assert.equal((await svc.calls.initiate({ user: agents[winnerIdx], tenantId: fx.A, authorizationId: auths[winnerIdx].authorizationId })).status, 'initiating');
  assert.equal((await pool.query(`SELECT status FROM voice_calls WHERE id=$1`, [auths[loserIdx].authorizationId])).rows[0].status, 'authorized');
  assert.ok((await pool.query(`SELECT 1 FROM voice_audit_logs WHERE action='call.capacity_full'`)).rowCount >= 2, 'refusals are logged');

  // When a live call ends, the line frees up and the waiting agent can claim.
  await svc.webhooks.handle(evt(auths[winnerIdx].authorizationId, 'hangup', { at: '2026-06-01T10:00:20Z', detail: { endTime: '2026-06-01T10:00:20Z', hangupCause: 'no_answer' } }));
  assert.equal((await svc.calls.initiate({ user: agents[loserIdx], tenantId: fx.A, authorizationId: auths[loserIdx].authorizationId })).status, 'initiating');
});

test('account-wide limit is configurable and 0 turns the local guard off', { skip }, async () => {
  await reset(); await enableRoute();
  const agents = await extraAgents(3);
  const auths = await Promise.all(agents.map((u) => auth(u)));
  process.env.VOICE_MAX_CONCURRENT_CALLS = '1';
  try {
    await svc.calls.initiate({ user: agents[0], tenantId: fx.A, authorizationId: auths[0].authorizationId });
    await assert.rejects(svc.calls.initiate({ user: agents[1], tenantId: fx.A, authorizationId: auths[1].authorizationId }), (e) => e.code === 'PROVIDER_ERROR');
    process.env.VOICE_MAX_CONCURRENT_CALLS = '0';
    assert.equal((await svc.calls.initiate({ user: agents[1], tenantId: fx.A, authorizationId: auths[1].authorizationId })).status, 'initiating');
  } finally { delete process.env.VOICE_MAX_CONCURRENT_CALLS; }
});

test('AGENT_BUSY still applies: one agent cannot hold two live calls even when the account has free lines', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); const b = await auth();
  await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  await assert.rejects(svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: b.authorizationId }), (e) => e.code === 'AGENT_BUSY' && e.status === 409);
});

test('provider-side capacity rejection (server-dial) is mapped to the same clear message, logged, and the reservation is released', { skip }, async () => {
  await reset(); await enableRoute(); fx.failDial = true; fx.capacityDial = true;
  try {
    const a = await auth();
    await assert.rejects(svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId, mode: 'server' }),
      (e) => e.status === 503 && e.code === 'PROVIDER_ERROR' && /lines are busy/.test(e.message));
    assert.deepEqual(await wal(), { a: '100000', r: '0' });
    assert.equal((await pool.query(`SELECT status FROM voice_calls WHERE id=$1`, [a.authorizationId])).rows[0].status, 'failed');
    assert.ok((await pool.query(`SELECT 1 FROM voice_audit_logs WHERE action='call.provider_capacity_limit' AND entity_id=$1`, [a.authorizationId])).rowCount >= 1);
  } finally { fx.failDial = false; fx.capacityDial = false; }
});

test('a hangup carrying "channel limit exceeded" is logged as a capacity event and costs nothing', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  await svc.webhooks.handle(evt(a.authorizationId, 'hangup', { at: '2026-06-01T10:00:02Z', detail: { endTime: '2026-06-01T10:00:02Z', hangupCause: 'call_rejected' }, payload: { sip_hangup_cause: '403', reason: 'User channel limit exceeded D1' } }));
  assert.ok((await pool.query(`SELECT 1 FROM voice_audit_logs WHERE action='call.provider_capacity_limit' AND entity_id=$1`, [a.authorizationId])).rowCount >= 1);
  assert.equal((await pool.query(`SELECT customer_cost::text c, status FROM voice_calls WHERE id=$1`, [a.authorizationId])).rows[0].c, '0');
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
});

test('changing the Telnyx connection drops stored agent credentials so /token mints them under the new connection', { skip }, async () => {
  const admin = require('../services/voiceCalling/admin').createAdminService({ query: svc.query });
  await pool.query(`INSERT INTO voice_agent_credentials (tenant_id, user_id, provider, provider_credential_id) VALUES ($1,$2,'telnyx','old-cred') ON CONFLICT DO NOTHING`, [fx.A, fx.admin1.id]);
  await admin.upsertAccount({ adminId: fx.admin1.id, tenantId: fx.A, body: { providerAccountReference: 'conn', allowedDestinationCountries: ['IN'], status: 'active' } }); // unchanged ref
  assert.equal((await pool.query(`SELECT 1 FROM voice_agent_credentials WHERE tenant_id=$1`, [fx.A])).rowCount, 1);
  await admin.upsertAccount({ adminId: fx.admin1.id, tenantId: fx.A, body: { providerAccountReference: '3086510505527870746', allowedDestinationCountries: ['IN'], status: 'active' } });
  assert.equal((await pool.query(`SELECT 1 FROM voice_agent_credentials WHERE tenant_id=$1`, [fx.A])).rowCount, 0);
  await admin.upsertAccount({ adminId: fx.admin1.id, tenantId: fx.A, body: { providerAccountReference: 'conn', allowedDestinationCountries: ['IN'], status: 'active' } }); // restore
});

// ---- cancelling right after starting a call ------------------------------------------------------------
test('cancelling a claim the provider has not confirmed frees the agent and the wallet at once', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: a.authorizationId });
  assert.equal((await svc.calls.hangup({ user: fx.admin1, tenantId: fx.A, callId: a.authorizationId })).status, 'canceled');
  assert.deepEqual(await wal(), { a: '100000', r: '0' });
  assert.equal((await pool.query(`SELECT status, hangup_cause FROM voice_calls WHERE id=$1`, [a.authorizationId])).rows[0].status, 'canceled');
  // the same agent can start again straight away (previously: "You already have a call in progress" for ~2 minutes)
  const b = await auth();
  assert.equal((await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: b.authorizationId })).status, 'initiating');
  // cancelling twice is harmless
  assert.equal((await svc.calls.hangup({ user: fx.admin1, tenantId: fx.A, callId: a.authorizationId })).status, 'canceled');
});

test('a call that did connect before the cancel was recorded is still billed when its provider events arrive', { skip }, async () => {
  await reset(); await enableRoute();
  const a = await auth(); const id = a.authorizationId;
  await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: id });
  await svc.calls.hangup({ user: fx.admin1, tenantId: fx.A, callId: id }); // released: provider had not confirmed anything yet
  await svc.webhooks.handle(evt(id, 'answered', { at: '2026-06-01T10:00:00Z' }));
  await svc.webhooks.handle(evt(id, 'hangup', { at: '2026-06-01T10:01:30Z', detail: { endTime: '2026-06-01T10:01:30Z', hangupCause: 'normal_clearing' } }));
  const c = (await pool.query(`SELECT status, billable_seconds, customer_cost::text cc FROM voice_calls WHERE id=$1`, [id])).rows[0];
  assert.equal(c.status, 'completed'); assert.equal(c.billable_seconds, 90); assert.equal(c.cc, '300'); // 90s rounds up to 2 billed minutes at the fixture's 1.50/min = 300 paise
});

test('a call the provider already knows about is still hung up through the provider, not released locally', { skip }, async () => {
  await reset(); await enableRoute(); providerLog.length = 0;
  const a = await auth(); const id = a.authorizationId;
  await svc.calls.initiate({ user: fx.admin1, tenantId: fx.A, authorizationId: id });
  await svc.webhooks.handle(evt(id, 'ringing', { at: '2026-06-01T10:00:00Z' })); // sets provider_call_id
  assert.equal((await svc.calls.hangup({ user: fx.admin1, tenantId: fx.A, callId: id })).status, 'hanging_up');
  assert.ok(providerLog.some(([k]) => k === 'hangup'));
  assert.equal((await pool.query(`SELECT status FROM voice_calls WHERE id=$1`, [id])).rows[0].status, 'ringing'); // final state comes from the webhook
});
