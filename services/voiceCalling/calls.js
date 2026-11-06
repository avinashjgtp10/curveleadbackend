// VoiceCallService: authorize -> initiate -> hangup. Final state/settlement comes from provider webhooks (webhooks.js).
const crypto = require('crypto');
const { query: defaultQuery, transaction: defaultTransaction } = require('../../config/db');
const { hasPermission: defaultHasPermission } = require('../../utils/permissions');
const { normalizeDestination } = require('./phone');
const { evaluateCallPolicy } = require('./countryPolicy');
const { formatRateMicro } = require('./money');
const { audit, maskNumber } = require('./audit');
const { ProviderError } = require('./providers/contract');

const AUTH_TTL_SECONDS = () => Number(process.env.VOICE_AUTH_TTL_SECONDS) || 60;
const RESERVE_CAP_SECONDS = () => Number(process.env.VOICE_RESERVE_CAP_SECONDS) || 900;
const VELOCITY_MAX_5MIN = () => Number(process.env.VOICE_VELOCITY_MAX_5MIN) || 20;
const LIVE = ['initiating', 'ringing', 'answered'];
// Telnyx limits the WHOLE account (currently 2 concurrent outbound calls). Count live calls platform-wide and refuse early, with a
// clear message, instead of letting the browser dial into a provider rejection. 0 disables the guard. Reuses the existing
// PROVIDER_ERROR code: it is a provider-side limit, so no new denial code is introduced.
const MAX_CONCURRENT = () => { const n = parseInt(process.env.VOICE_MAX_CONCURRENT_CALLS, 10); return Number.isInteger(n) && n >= 0 ? n : 2; };
const CAPACITY_MESSAGE = 'All call lines are busy right now. Please try again in a moment.';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const encodeState = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const decodeState = (s) => { try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); } catch { return null; } };

function createCallService(deps = {}) {
  const db = deps.query || defaultQuery;
  const tx = deps.transaction || defaultTransaction;
  const hasPermission = deps.hasPermission || defaultHasPermission;
  const getProvider = deps.getProvider || require('./providers/factory').getVoiceProvider;
  const policies = deps.policies || require('./countryPolicy').createCountryPolicyService({ query: db });
  const rates = deps.rates || require('./rates').createRateService({ query: db });
  const wallet = deps.wallet || require('./wallet').createWalletService({ query: db, transaction: tx });
  const providerId = () => deps.providerId || process.env.VOICE_DEFAULT_PROVIDER || 'telnyx';
  const webhookUrl = () => deps.webhookUrl || (process.env.API_BASE_URL ? `${process.env.API_BASE_URL}/api/voice/webhooks/telnyx` : undefined);

  const deny = async (ctx, code, message, status = 403, extra = {}) => {
    await audit(db, { tenantId: ctx.tenantId, actorId: ctx.user.id, action: 'call.denied', entityId: ctx.leadId, detail: { code, ...extra } });
    throw fail(status, code, message);
  };

  // Caller ID per call. Order: a number assigned to this agent, then one whose country matches the DESTINATION
  // (so an India number can later serve +91 with no API change), then any other verified org number.
  // Never another agent's number. Numbers come from voice_phone_numbers, not from config or code.
  async function pickCallerId(tenantId, provider, agentId, destinationCountry) {
    const r = await db(
      `SELECT * FROM voice_phone_numbers WHERE tenant_id=$1 AND provider=$2 AND verification_status='verified'
         AND (capabilities->>'voice_outbound')::boolean IS TRUE AND (assigned_agent_id=$3 OR assigned_agent_id IS NULL)
       ORDER BY (assigned_agent_id=$3) DESC NULLS LAST, (country_code=$4) DESC, created_at LIMIT 1`, [tenantId, provider, agentId, destinationCountry]);
    return r.rows[0] || null;
  }

  return {
    encodeState, decodeState,

    async authorize({ user, tenantId, originCountry, leadId, wantRecording = false }) {
      const ctx = { user, tenantId, leadId };
      if (!(await hasPermission(user, 'voice.call'))) return deny(ctx, 'FORBIDDEN', 'You do not have permission to place calls.');

      const lead = (await db('SELECT id, name, phone, assigned_to FROM leads WHERE id=$1 AND tenant_id=$2', [leadId, tenantId])).rows[0];
      if (!lead) throw fail(404, 'LEAD_NOT_FOUND', 'Lead not found.');
      const isAdmin = ['admin', 'super_admin'].includes(user.role);
      if (!isAdmin && lead.assigned_to !== user.id) return deny(ctx, 'LEAD_NOT_OWNED', 'This lead is not assigned to you.');

      const provider = providerId();
      const account = (await db('SELECT * FROM voice_accounts WHERE tenant_id=$1 AND provider=$2', [tenantId, provider])).rows[0];
      const destination = normalizeDestination(lead.phone, originCountry);
      if (!destination) return deny(ctx, 'INVALID_NUMBER', 'The lead\'s phone number is not valid for calling.', 422);

      const policy = originCountry ? await policies.getPolicy(originCountry, destination.country) : null;
      const callerId = account ? await pickCallerId(tenantId, provider, user.id, destination?.country) : null;
      const verdict = evaluateCallPolicy({
        originCountry, destination, account, policy, callerId, wantRecording,
        hasActiveConsent: policy?.requires_contact_consent ? await policies.hasActiveConsent(tenantId, leadId) : true,
        now: new Date(),
      });
      if (!verdict.allowed) return deny(ctx, verdict.code, verdict.message, 403, { country: destination.country });

      // ---- fraud / abuse limits
      const usage = (await db(
        `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS day_calls,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '5 minutes') AS recent_calls,
                COALESCE(SUM(COALESCE(customer_cost, reserved_amount)) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND status NOT IN ('expired','canceled')), 0) AS day_spend
         FROM voice_calls WHERE tenant_id=$1 AND agent_id=$2`, [tenantId, user.id])).rows[0];
      if (Number(usage.day_calls) >= account.daily_call_limit_per_agent) return deny(ctx, 'DAILY_LIMIT', 'Daily calling limit reached.', 429);
      if (Number(usage.recent_calls) >= VELOCITY_MAX_5MIN()) return deny(ctx, 'SUSPICIOUS_VELOCITY', 'Too many calls in a short time.', 429);
      const orgSpend = (await db(
        `SELECT COALESCE(SUM(COALESCE(customer_cost, reserved_amount)),0) AS s FROM voice_calls
         WHERE tenant_id=$1 AND created_at > NOW() - INTERVAL '24 hours' AND status NOT IN ('expired','canceled')`, [tenantId])).rows[0].s;
      if (BigInt(account.daily_spend_limit_minor) > 0n && BigInt(orgSpend) >= BigInt(account.daily_spend_limit_minor)) return deny(ctx, 'SPEND_LIMIT', 'Daily calling spend limit reached.', 429);

      const rate = await rates.resolveRate({ tenantId, provider, destination, currency: account.default_currency });
      if (!rate) return deny(ctx, 'NO_RATE', 'No calling rate is configured for this destination.');

      // ---- authorize + reserve atomically
      const callId = crypto.randomUUID();
      const wantSeconds = Math.min(verdict.maxCallSeconds, RESERVE_CAP_SECONDS());
      let reserved;
      try {
        reserved = await tx(async (c) => {
          // Call row first: the ledger entry references it. A failed reservation rolls the whole transaction back.
          await c.query(
            `INSERT INTO voice_calls (id, tenant_id, lead_id, agent_id, provider, direction, from_number, to_number, destination_country, call_type,
               status, authorization_expires_at, max_duration_seconds, reserved_amount, rate_card_id, selling_rate_micro, cost_rate_micro, billing_increment_seconds, currency)
             VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9,'authorized', NOW() + ($10 || ' seconds')::interval,$11,0,$12,$13,$14,$15,$16)`,
            [callId, tenantId, leadId, user.id, provider, callerId.phone_number_e164, destination.e164, destination.country, rate.call_type,
              String(AUTH_TTL_SECONDS()), wantSeconds, rate.id, String(rate.selling_price_per_minute_micro), String(rate.cost_per_minute_micro),
              rate.billing_increment_seconds, account.default_currency]);
          const r = await wallet.reserveInTx(c, {
            tenantId, currency: account.default_currency, callId, sellingRateMicro: rate.selling_price_per_minute_micro,
            incrementSeconds: rate.billing_increment_seconds, wantSeconds,
          });
          await c.query('UPDATE voice_calls SET max_duration_seconds=$2, reserved_amount=$3 WHERE id=$1', [callId, r.seconds, String(r.amount)]);
          return r;
        });
      } catch (e) {
        if (e.code === 'INSUFFICIENT_BALANCE' || e.code === 'NO_WALLET') return deny(ctx, e.code, e.message, 402);
        throw e;
      }
      await audit(db, { tenantId, actorId: user.id, action: 'call.authorized', entityId: callId, detail: { country: destination.country, maxSeconds: reserved.seconds } });
      return {
        authorizationId: callId,
        expiresInSeconds: AUTH_TTL_SECONDS(),
        lead: { id: lead.id, name: lead.name },
        callerId: callerId.phone_number_e164,
        destination: { country: destination.country, number: destination.e164 },
        rate: formatRateMicro(rate.selling_price_per_minute_micro, rate.currency),
        billingIncrementSeconds: rate.billing_increment_seconds,
        maxDurationSeconds: reserved.seconds,
      };
    },

    async initiate({ user, tenantId, authorizationId, mode = 'client' }) {
      // Atomic claim: only one caller can move authorized -> initiating, and only before expiry. A global advisory lock
      // serialises claims so two agents cannot both take the last free line.
      let call;
      try {
        call = await tx(async (c) => {
          await c.query(`SELECT pg_advisory_xact_lock(hashtext('voice:capacity'))`);
          const cur = (await c.query(
            `SELECT id FROM voice_calls WHERE id=$1 AND tenant_id=$2 AND agent_id=$3 AND status='authorized' AND authorization_expires_at > NOW() FOR UPDATE`,
            [authorizationId, tenantId, user.id])).rows[0];
          if (!cur) return null; // not claimable: handled below (idempotent retry / expired / not found)
          const cap = MAX_CONCURRENT();
          if (cap > 0) {
            const live = Number((await c.query(`SELECT COUNT(*) AS n FROM voice_calls WHERE status IN ('initiating','ringing','answered')`)).rows[0].n);
            if (live >= cap) throw Object.assign(fail(503, 'PROVIDER_ERROR', CAPACITY_MESSAGE), { capacityFull: true, live, cap });
          }
          return (await c.query(`UPDATE voice_calls SET status='initiating', started_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [authorizationId])).rows[0];
        });
      } catch (e) {
        if (e.code === '23505') throw fail(409, 'AGENT_BUSY', 'You already have a call in progress.');
        if (e.capacityFull) await audit(db, { tenantId, actorId: user.id, action: 'call.capacity_full', entityId: authorizationId, detail: { live: e.live, limit: e.cap } });
        throw e;
      }
      if (!call) {
        const existing = (await db('SELECT id, status, provider_call_id FROM voice_calls WHERE id=$1 AND tenant_id=$2 AND agent_id=$3', [authorizationId, tenantId, user.id])).rows[0];
        if (!existing) throw fail(404, 'AUTH_NOT_FOUND', 'Call authorization not found.');
        if (LIVE.includes(existing.status)) return { callId: existing.id, status: existing.status }; // idempotent retry
        throw fail(409, 'AUTH_EXPIRED', 'Call authorization has expired. Please try again.');
      }
      // Browser/mobile SDK places the audio call itself (the agent's mic is the media leg); the server only
      // claims the authorization and hands back what the client must dial. Webhooks correlate via client_state.
      if (mode === 'client') {
        await audit(db, { tenantId, actorId: user.id, action: 'call.claimed', entityId: call.id });
        return {
          callId: call.id, status: 'initiating', mode: 'client',
          dial: { from: call.from_number, to: call.to_number, clientState: encodeState({ c: call.id, t: tenantId }), maxDurationSeconds: call.max_duration_seconds },
        };
      }
      const account = (await db('SELECT * FROM voice_accounts WHERE tenant_id=$1 AND provider=$2', [tenantId, call.provider])).rows[0];
      try {
        const provider = getProvider(call.provider);
        const res = await provider.initiateCall({
          account, from: call.from_number, to: call.to_number, timeLimitSeconds: call.max_duration_seconds,
          clientState: encodeState({ c: call.id, t: tenantId }), commandId: call.id, webhookUrl: webhookUrl(),
        });
        await db('UPDATE voice_calls SET provider_call_id=COALESCE(provider_call_id,$2), provider_session_id=$3, updated_at=NOW() WHERE id=$1',
          [call.id, res.providerCallId, res.providerSessionId]);
        await audit(db, { tenantId, actorId: user.id, action: 'call.initiated', entityId: call.id, detail: { to: maskNumber(call.to_number) } });
        return { callId: call.id, status: 'initiating' };
      } catch (e) {
        // Setup failed: nothing was dialled, so give the whole reservation back.
        await tx(async (c) => {
          const cur = (await c.query('SELECT * FROM voice_calls WHERE id=$1 FOR UPDATE', [call.id])).rows[0];
          if (!cur || cur.status !== 'initiating') return;
          await wallet.releaseInTx(c, { tenantId, currency: cur.currency, callId: cur.id, amount: cur.reserved_amount });
          await c.query(`UPDATE voice_calls SET status='failed', reserved_amount=0, hangup_cause='provider_setup_failed', ended_at=NOW(), updated_at=NOW() WHERE id=$1`, [cur.id]);
        });
        await audit(db, { tenantId, actorId: user.id, action: 'call.setup_failed', entityId: call.id, detail: { error: e.message } });
        if (e instanceof ProviderError && e.capacity) {
          await audit(db, { tenantId, actorId: user.id, action: 'call.provider_capacity_limit', entityId: call.id, detail: { status: e.status, codes: e.codes } });
          throw fail(503, 'PROVIDER_ERROR', CAPACITY_MESSAGE);
        }
        throw e instanceof ProviderError ? fail(502, 'PROVIDER_ERROR', 'The calling provider is unavailable. Please try again.') : e;
      }
    },

    async hangup({ user, tenantId, callId }) {
      const call = (await db('SELECT * FROM voice_calls WHERE id=$1 AND tenant_id=$2', [callId, tenantId])).rows[0];
      if (!call) throw fail(404, 'CALL_NOT_FOUND', 'Call not found.');
      if (call.agent_id !== user.id && !['admin', 'super_admin'].includes(user.role)) throw fail(403, 'FORBIDDEN', 'Not your call.');
      if (call.status === 'authorized') { // never dialled: cancel and release
        await this.cancelAuthorization({ callId, tenantId });
        return { status: 'canceled' };
      }
      if (!LIVE.includes(call.status)) return { status: call.status };
      if (!call.provider_call_id) {
        // Claimed by the browser but the provider has not reported it (yet): the agent is cancelling, and their browser has already
        // hung up. Release the claim now instead of leaving the agent "busy" until the sweeper runs. A late provider event is still
        // billed correctly (see webhooks.js), so a call that did connect is never lost.
        if (call.status === 'initiating') { await this.cancelUnconfirmedClaim({ callId, tenantId }); return { status: 'canceled' }; }
        throw fail(409, 'CALL_NOT_READY', 'Call is still being set up. Try again in a moment.');
      }
      try { await getProvider(call.provider).hangupCall({ providerCallId: call.provider_call_id, commandId: `hangup:${call.id}` }); }
      catch (e) { throw fail(502, 'PROVIDER_ERROR', 'Could not hang up via the provider. Try again.'); }
      return { status: 'hanging_up' }; // authoritative end + settlement arrive via the call.hangup webhook
    },

    async setOutcome({ user, tenantId, callId, outcome, notes }) {
      const OUTCOMES = ['connected', 'no_answer', 'busy', 'wrong_number', 'interested', 'not_interested', 'follow_up_required'];
      if (!OUTCOMES.includes(outcome)) throw fail(400, 'BAD_OUTCOME', 'Unknown call outcome.');
      const text = typeof notes === 'string' ? notes.trim().slice(0, 2000) : '';
      const isAdmin = ['admin', 'super_admin'].includes(user.role);
      const c = (await db(
        `UPDATE voice_calls SET outcome=$3, outcome_notes=$4, updated_at=NOW()
         WHERE id=$1 AND tenant_id=$2 AND ($5::boolean OR agent_id=$6) AND status NOT IN ('authorized','expired') RETURNING id, lead_id`,
        [callId, tenantId, outcome, text || null, isAdmin, user.id])).rows[0];
      if (!c) throw fail(404, 'CALL_NOT_FOUND', 'Call not found.');
      if (c.lead_id) {
        await db(`INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, metadata, created_by) VALUES ($1,$2,'call',$3,$4,$5,$6)`,
          [tenantId, c.lead_id, `Call outcome: ${outcome.replace(/_/g, ' ')}`, text || null, JSON.stringify({ voice_call_id: c.id, outcome }), user.id]);
      }
      return { id: c.id, outcome };
    },

    // Per-agent totals for the reports page (admins only; enforced by the route).
    async agentReport({ tenantId, from, to }) {
      return (await db(
        `SELECT u.id AS agent_id, u.name, COUNT(*) AS calls,
                COUNT(*) FILTER (WHERE c.answered_at IS NOT NULL) AS connected,
                COALESCE(SUM(c.billable_seconds),0) AS billable_seconds,
                COALESCE(SUM(c.customer_cost),0) AS spend_minor, MAX(c.currency) AS currency
         FROM voice_calls c JOIN users u ON u.id=c.agent_id
         WHERE c.tenant_id=$1 AND c.status NOT IN ('authorized','expired','canceled') AND c.created_at >= $2 AND c.created_at < $3
         GROUP BY u.id, u.name ORDER BY calls DESC`, [tenantId, from, to])).rows;
    },

    async cancelUnconfirmedClaim({ callId, tenantId }) {
      return tx(async (c) => {
        const cur = (await c.query(`SELECT * FROM voice_calls WHERE id=$1 AND tenant_id=$2 AND status='initiating' AND provider_call_id IS NULL FOR UPDATE`, [callId, tenantId])).rows[0];
        if (!cur) return false;
        await wallet.releaseInTx(c, { tenantId, currency: cur.currency, callId, amount: cur.reserved_amount });
        await c.query(`UPDATE voice_calls SET status='canceled', reserved_amount=0, hangup_cause='canceled_by_agent', ended_at=NOW(), updated_at=NOW() WHERE id=$1`, [callId]);
        return true;
      });
    },

    async cancelAuthorization({ callId, tenantId }) {
      return tx(async (c) => {
        const cur = (await c.query(`SELECT * FROM voice_calls WHERE id=$1 AND tenant_id=$2 AND status='authorized' FOR UPDATE`, [callId, tenantId])).rows[0];
        if (!cur) return false;
        await wallet.releaseInTx(c, { tenantId, currency: cur.currency, callId, amount: cur.reserved_amount });
        await c.query(`UPDATE voice_calls SET status='canceled', reserved_amount=0, updated_at=NOW() WHERE id=$1`, [callId]);
        return true;
      });
    },

    // Sweeper: unused authorizations -> expired (+release); live calls with no final event for too long -> flagged and released.
    async expireStale(limit = 100) {
      const rows = (await db(
        `SELECT id, tenant_id FROM voice_calls WHERE status='authorized' AND authorization_expires_at < NOW() ORDER BY authorization_expires_at LIMIT $1`, [limit])).rows;
      let n = 0;
      for (const r of rows) {
        await tx(async (c) => {
          const cur = (await c.query(`SELECT * FROM voice_calls WHERE id=$1 AND status='authorized' AND authorization_expires_at < NOW() FOR UPDATE`, [r.id])).rows[0];
          if (!cur) return;
          await wallet.releaseInTx(c, { tenantId: cur.tenant_id, currency: cur.currency, callId: cur.id, amount: cur.reserved_amount });
          await c.query(`UPDATE voice_calls SET status='expired', reserved_amount=0, updated_at=NOW() WHERE id=$1`, [cur.id]);
          n++;
        });
      }
      // Client-mode claims where the browser never dialled: free the agent and the reservation quickly.
      const abandoned = (await db(
        `SELECT id FROM voice_calls WHERE status='initiating' AND provider_call_id IS NULL AND updated_at < NOW() - INTERVAL '120 seconds' LIMIT $1`, [limit])).rows;
      for (const r of abandoned) {
        await tx(async (c) => {
          const cur = (await c.query(`SELECT * FROM voice_calls WHERE id=$1 AND status='initiating' AND provider_call_id IS NULL FOR UPDATE`, [r.id])).rows[0];
          if (!cur) return;
          await wallet.releaseInTx(c, { tenantId: cur.tenant_id, currency: cur.currency, callId: cur.id, amount: cur.reserved_amount });
          await c.query(`UPDATE voice_calls SET status='failed', reserved_amount=0, hangup_cause='never_dialled', ended_at=NOW(), updated_at=NOW() WHERE id=$1`, [cur.id]);
        });
      }
      // Authorized duration is a hard limit: force-hangup answered calls that ran past it.
      const overrun = (await db(
        `SELECT id, provider, provider_call_id FROM voice_calls WHERE status='answered' AND provider_call_id IS NOT NULL
           AND answered_at < NOW() - (max_duration_seconds || ' seconds')::interval LIMIT $1`, [limit])).rows;
      for (const r of overrun) {
        try { await getProvider(r.provider).hangupCall({ providerCallId: r.provider_call_id, commandId: `limit:${r.id}` }); } catch (e) { console.error('overrun hangup failed:', e.message); }
      }
      const stuck = (await db(
        `SELECT id, tenant_id FROM voice_calls WHERE status IN ('initiating','ringing','answered')
           AND updated_at < NOW() - (max_duration_seconds + 600 || ' seconds')::interval LIMIT $1`, [limit])).rows;
      for (const r of stuck) {
        await tx(async (c) => {
          const cur = (await c.query(`SELECT * FROM voice_calls WHERE id=$1 AND status IN ('initiating','ringing','answered') FOR UPDATE`, [r.id])).rows[0];
          if (!cur) return;
          await wallet.releaseInTx(c, { tenantId: cur.tenant_id, currency: cur.currency, callId: cur.id, amount: cur.reserved_amount });
          await c.query(`UPDATE voice_calls SET status='failed', reserved_amount=0, hangup_cause='no_final_event', ended_at=NOW(), updated_at=NOW() WHERE id=$1`, [cur.id]);
        });
        await audit(db, { tenantId: r.tenant_id, action: 'call.stuck_released', entityId: r.id, detail: { needs: 'manual reconciliation' } });
      }
      return { expired: n, abandoned: abandoned.length, overrun: overrun.length, stuck: stuck.length };
    },

    async list({ user, tenantId, limit = 50, offset = 0, leadId }) {
      const isAdmin = ['admin', 'super_admin'].includes(user.role);
      const r = await db(
        `SELECT id, lead_id, agent_id, direction, from_number, to_number, destination_country, status, started_at, answered_at, ended_at,
                duration_seconds, billable_seconds, customer_cost, currency, outcome
         FROM voice_calls WHERE tenant_id=$1 AND ($2::uuid IS NULL OR lead_id=$2) AND ($3::boolean OR agent_id=$4) AND status <> 'expired'
         ORDER BY created_at DESC LIMIT $5 OFFSET $6`, [tenantId, leadId || null, isAdmin, user.id, Math.min(limit, 200), offset]);
      return r.rows;
    },
    async get({ user, tenantId, callId }) {
      const isAdmin = ['admin', 'super_admin'].includes(user.role);
      const c = (await db(
        `SELECT id, lead_id, agent_id, direction, from_number, to_number, destination_country, status, started_at, answered_at, ended_at,
                duration_seconds, billable_seconds, customer_cost, currency, outcome, outcome_notes, hangup_cause
         FROM voice_calls WHERE id=$1 AND tenant_id=$2 AND ($3::boolean OR agent_id=$4)`, [callId, tenantId, isAdmin, user.id])).rows[0];
      if (!c) throw fail(404, 'CALL_NOT_FOUND', 'Call not found.');
      return c;
    },
  };
}
module.exports = { createCallService, encodeState, decodeState, CAPACITY_MESSAGE };
