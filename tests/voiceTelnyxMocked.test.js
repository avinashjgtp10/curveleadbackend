// Telnyx is MOCKED everywhere in this file: no network, no real key, no calls. Test keys below are fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelnyxProvider } = require('../services/voiceCalling/providers/telnyx');
const { ProviderError } = require('../services/voiceCalling/providers/contract');
const { createTokenService } = require('../services/voiceCalling/tokens');

const FAKE_KEY = 'KEYfakefakefakefakefake';
const CONNECTION = '3086510505527870746';
const account = { provider_account_reference: CONNECTION, status: 'active' };
const httpErr = (status, errors) => { const e = new Error('x'); e.response = { status, data: { errors } }; return e; };
const prov = (http) => createTelnyxProvider({ http, apiKey: FAKE_KEY, now: () => 1_800_000_000_000 });

test('concurrent-call limits are recognised from the documented Telnyx signals only', async () => {
  const cases = [
    [httpErr(403, [{ code: '10010', title: 'Forbidden', detail: 'User channel limit exceeded D1' }]), true],   // account limit (SIP 403 text)
    [httpErr(403, [{ code: '90043', title: 'Connection outbound channels limit exceeded' }]), true],            // connection limit
    [httpErr(422, [{ code: '90043' }]), true],                                                                  // by code, whatever the status
    [httpErr(429, [{ code: '90103', title: 'Dials per second limit' }]), false],                                // DPS limit is NOT concurrency
    [httpErr(403, [{ code: '10010', title: 'Forbidden', detail: 'Not allowed' }]), false],                      // unrelated 403
    [httpErr(401, [{ code: '10009', title: 'Authentication failed' }]), false],
  ];
  for (const [err, capacity] of cases) {
    const p = prov({ request: async () => { throw err; } });
    await assert.rejects(p.initiateCall({ account, from: '+15673603199', to: '+919665624277', clientState: 'c', commandId: 'k', timeLimitSeconds: 60 }),
      (e) => e instanceof ProviderError && e.capacity === capacity, JSON.stringify(err.response));
  }
});
test('429 is retryable, 401 is not, and no error ever contains the API key or request data', async () => {
  const run = async (status) => prov({ request: async () => { throw httpErr(status, [{ code: '1', detail: 'd' }]); } })
    .hangupCall({ providerCallId: 'c-1' }).then(() => null, (e) => e);
  const e429 = await run(429); const e401 = await run(401);
  assert.equal(e429.retryable, true); assert.equal(e401.retryable, false); assert.equal(e401.status, 401);
  for (const e of [e429, e401]) assert.ok(!JSON.stringify({ m: e.message, c: e.codes }).includes(FAKE_KEY));
});

test('initiateCall (server-dial mode) targets the configured connection and never sends extra secrets', async () => {
  const seen = [];
  const p = prov({ request: async (r) => { seen.push(r); return { data: { data: { call_control_id: 'cc1', call_session_id: 's1' } } }; } });
  await p.initiateCall({ account, from: '+15673603199', to: '+971501234567', clientState: 'cs', commandId: 'cmd', timeLimitSeconds: 600 });
  assert.equal(seen[0].data.connection_id, CONNECTION); assert.equal(seen[0].data.from, '+15673603199'); assert.equal(seen[0].data.to, '+971501234567');
  assert.equal(seen[0].headers.Authorization, `Bearer ${FAKE_KEY}`); // header only, never in the body
  assert.ok(!JSON.stringify(seen[0].data).includes(FAKE_KEY));
});

// ---- /token --------------------------------------------------------------------------------------
const tokenDeps = (calls, over = {}) => {
  const rows = { cred: over.cred ?? null };
  const db = async (sql, params) => {
    calls.push([sql, params]);
    if (/FROM voice_accounts/.test(sql)) return { rows: [account] };
    if (/FROM voice_agent_credentials/.test(sql)) return { rows: rows.cred ? [{ provider_credential_id: rows.cred }] : [] };
    if (/DELETE FROM voice_agent_credentials/.test(sql)) { rows.cred = null; return { rows: [] }; }
    return { rows: [], rowCount: 1 };
  };
  const seen = [];
  const http = { request: async (r) => {
    seen.push(r);
    if (r.url === '/telephony_credentials') return { data: { data: { id: 'cred-NEW' } } };
    if (r.url.endsWith('/token')) {
      if (over.missingCred && r.url.includes(over.missingCred)) throw httpErr(404, [{ code: '10005', title: 'Resource not found' }]);
      return { data: 'eyJ.fake.jwt' };
    }
    throw new Error(`unexpected ${r.url}`);
  } };
  return { db, seen, service: createTokenService({ query: db, hasPermission: async () => true, getProvider: () => prov(http) }) };
};
const agent = { id: 'agent-1', role: 'staff' };

test('/token creates a per-agent credential under the configured connection and returns only the login token', async () => {
  const calls = []; const t = tokenDeps(calls);
  const out = await t.service.issue({ user: agent, tenantId: 'T1' });
  assert.deepEqual(Object.keys(out).sort(), ['expiresAt', 'provider', 'token']);
  assert.equal(out.token, 'eyJ.fake.jwt');
  assert.equal(t.seen[0].url, '/telephony_credentials'); assert.equal(t.seen[0].data.connection_id, CONNECTION);
  const body = JSON.stringify(out); assert.ok(!body.includes(FAKE_KEY) && !body.includes('cred-NEW'));
  const insert = calls.find(([sql]) => /INSERT INTO voice_agent_credentials/.test(sql));
  assert.deepEqual(insert[1], ['T1', 'agent-1', 'telnyx', 'cred-NEW']); // keyed by tenant + user: one credential per agent
  const logged = JSON.stringify(calls.filter(([sql]) => /voice_audit_logs/.test(sql)));
  assert.ok(!logged.includes('eyJ') && !logged.includes(FAKE_KEY), 'tokens and keys never reach the audit log');
});
test('/token reuses an agent\'s credential and recreates it once if Telnyx no longer has it', async () => {
  const calls = []; const reuse = tokenDeps(calls, { cred: 'cred-OLD' });
  await reuse.service.issue({ user: agent, tenantId: 'T1' });
  assert.ok(!reuse.seen.some((r) => r.url === '/telephony_credentials'), 'no new credential when one exists');
  const gone = tokenDeps([], { cred: 'cred-GONE', missingCred: 'cred-GONE' });
  const out = await gone.service.issue({ user: agent, tenantId: 'T1' });
  assert.equal(out.token, 'eyJ.fake.jwt');
  assert.equal(gone.seen.filter((r) => r.url === '/telephony_credentials').length, 1);
});
test('/token is refused without permission or an active account', async () => {
  const noPerm = createTokenService({ query: async () => ({ rows: [account] }), hasPermission: async () => false, getProvider: () => prov({ request: async () => { throw new Error('must not be called'); } }) });
  await assert.rejects(noPerm.issue({ user: agent, tenantId: 'T1' }), (e) => e.code === 'FORBIDDEN');
  const inactive = createTokenService({ query: async () => ({ rows: [{ ...account, status: 'pending' }] }), hasPermission: async () => true, getProvider: () => { throw new Error('must not be called'); } });
  await assert.rejects(inactive.issue({ user: agent, tenantId: 'T1' }), (e) => e.code === 'ACCOUNT_INACTIVE');
});

// ---- HTTP mapping: a provider 401 must never reach the browser as a 401 (the app treats 401 as "logged out") ----
test('provider failures are returned as 502 PROVIDER_ERROR, never as the provider\'s own status', async () => {
  process.env.VOICE_TELNYX_API_KEY = FAKE_KEY;
  process.env.VOICE_TELNYX_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
  const idx = require('../services/voiceCalling');
  idx.services = () => ({ tokens: { issue: async () => { throw new ProviderError('Telnyx POST /x failed (401)', { status: 401 }); } } });
  const controller = require('../controllers/voiceCallingController');
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await controller.token({ user: agent, tenantId: 'T1' }, res);
  assert.equal(res.code, 502); assert.equal(res.body.code, 'PROVIDER_ERROR');
  assert.ok(!JSON.stringify(res.body).includes('401') && !JSON.stringify(res.body).includes('Telnyx'));
});
