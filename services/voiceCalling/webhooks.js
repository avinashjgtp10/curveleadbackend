// VoiceWebhookService: verified, replay-safe, idempotent, order-tolerant processing of provider events
// and authoritative settlement. Voice media never touches this server; only signalling events do.
const { query: defaultQuery, transaction: defaultTransaction } = require('../../config/db');
const { chargeMinor } = require('./money');
const { audit } = require('./audit');
const { decodeState } = require('./calls');

const RANK = { authorized: 0, initiating: 1, ringing: 2, answered: 3 };
const TERMINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'canceled', 'expired']);
const GRACE_SECONDS = 10; // billable time is capped at the authorized duration + this

// Heuristic mapping of a Telnyx hangup_cause for a call that never connected. Unknown => 'failed'.
const unansweredStatus = (cause) => {
  const c = String(cause || '').toLowerCase();
  if (c === 'user_busy') return 'busy';
  if (c === 'no_answer' || c === 'timeout') return 'no_answer';
  if (c === 'originator_cancel') return 'canceled';
  return 'failed';
};

function createWebhookService(deps = {}) {
  const db = deps.query || defaultQuery;
  const tx = deps.transaction || defaultTransaction;
  const getProvider = deps.getProvider || require('./providers/factory').getVoiceProvider;
  const wallet = deps.wallet || require('./wallet').createWalletService({ query: db, transaction: tx });

  async function findCall(c, ev) {
    const st = ev.clientState ? decodeState(ev.clientState) : null;
    if (st?.c && st?.t) {
      const r = await c.query('SELECT * FROM voice_calls WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [st.c, st.t]);
      if (r.rows[0]) return r.rows[0];
    }
    if (ev.providerCallId) {
      const r = await c.query('SELECT * FROM voice_calls WHERE provider=$1 AND provider_call_id=$2 FOR UPDATE', ['telnyx', ev.providerCallId]);
      if (r.rows[0]) return r.rows[0];
    }
    return null;
  }

  // Computes and applies final charges. Safe to call again: the wallet ledger key makes the debit once-only;
  // a late "answered" can correct an earlier zero-charge settlement via a single delta adjustment.
  async function settle(c, call) {
    const answeredAt = call.answered_at ? new Date(call.answered_at) : null;
    const endedAt = call.ended_at ? new Date(call.ended_at) : null;
    const duration = answeredAt && endedAt ? Math.max(0, Math.floor((endedAt - answeredAt) / 1000)) : 0;
    const billable = Math.min(duration, call.max_duration_seconds + GRACE_SECONDS);
    const charge = chargeMinor(billable, call.selling_rate_micro ?? 0, call.billing_increment_seconds);
    const providerCost = chargeMinor(billable, call.cost_rate_micro ?? 0, call.billing_increment_seconds); // estimate until reconciled
    const settledBefore = !!call.settled_at;
    if (!settledBefore) {
      await wallet.settleInTx(c, { tenantId: call.tenant_id, currency: call.currency, callId: call.id, reservedAmount: call.reserved_amount, chargeAmount: charge });
    } else {
      const delta = charge - BigInt(call.customer_cost ?? 0);
      if (delta > 0n) {
        const w = await wallet.lockWallet(c, call.tenant_id, call.currency);
        if (await wallet.ledger(c, { tenantId: call.tenant_id, walletId: w.id, callId: call.id, type: 'adjustment', amount: delta, currency: call.currency, key: `settle-adjust:${call.id}` })) {
          await c.query('UPDATE voice_wallets SET available_balance = available_balance - $2, updated_at=NOW() WHERE id=$1', [w.id, String(delta)]);
        } else return;
      } else return;
    }
    await c.query(
      `UPDATE voice_calls SET duration_seconds=$2, billable_seconds=$3, customer_cost=$4, provider_cost=$5, reserved_amount=0,
         settled_at=COALESCE(settled_at, NOW()), updated_at=NOW() WHERE id=$1`,
      [call.id, duration, billable, String(charge), String(providerCost)]);
    if (!settledBefore) {
      await c.query(
        `INSERT INTO lead_activities (tenant_id, lead_id, activity_type, title, description, metadata, created_by)
         SELECT $1,$2,'call',$3,$4,$5,$6 WHERE $2::uuid IS NOT NULL`,
        [call.tenant_id, call.lead_id, `Call ${call.status === 'completed' ? 'completed' : `— ${call.status.replace('_', ' ')}`}`,
          answeredAt ? `Duration ${duration}s` : 'Not connected', JSON.stringify({ voice_call_id: call.id, status: call.status, duration_seconds: duration }), call.agent_id]);
      if (answeredAt) await c.query('UPDATE leads SET last_contacted_at=NOW() WHERE id=$1 AND tenant_id=$2', [call.lead_id, call.tenant_id]);
    }
  }

  return {
    // Throws {status:401} on signature failure so the route can reject; everything else resolves.
    async handle({ providerId = 'telnyx', rawBody, headers }) {
      let ev;
      try { ev = getProvider(providerId).verifyWebhook({ rawBody, headers }); }
      catch (e) { console.warn(JSON.stringify({ evt: 'voice.webhook.rejected', reason: e.message })); throw Object.assign(new Error('Invalid webhook.'), { status: 401 }); }

      return tx(async (c) => {
        const call = await findCall(c, ev);
        if (!call) return { handled: false, reason: 'unknown_call' };

        const ins = await c.query(
          `INSERT INTO voice_call_events (tenant_id, call_id, provider, provider_event_id, event_type, occurred_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
          [call.tenant_id, call.id, providerId, ev.providerEventId, ev.rawType, ev.occurredAt, JSON.stringify(ev.payload)]);
        if (ins.rowCount === 0) return { handled: true, duplicate: true };

        // Keep provider ids on first sight (webhook can beat the dial response).
        await c.query('UPDATE voice_calls SET provider_call_id=COALESCE(provider_call_id,$2), provider_session_id=COALESCE(provider_session_id,$3) WHERE id=$1',
          [call.id, ev.providerCallId, ev.providerSessionId]);

        // The browser dials, so verify the provider saw the number we authorized. A mismatch means a tampered
        // client: kill the call and flag it. (Compared only when the provider payload carries `to`.)
        const dialled = ev.payload?.data?.payload?.to;
        if (dialled && ev.type !== 'hangup' && !TERMINAL.has(call.status) && String(dialled).replace(/\s/g, '') !== call.to_number) {
          if (call.provider_call_id || ev.providerCallId) {
            try { await getProvider(providerId).hangupCall({ providerCallId: call.provider_call_id || ev.providerCallId, commandId: `mismatch:${call.id}` }); } catch (e) { console.error('mismatch hangup failed:', e.message); }
          }
          await audit(null, { tenantId: call.tenant_id, action: 'call.destination_mismatch', entityId: call.id });
          return { handled: true, rejected: 'destination_mismatch' };
        }

        const terminal = TERMINAL.has(call.status);
        if (ev.type === 'ringing' || ev.type === 'answered') {
          const target = ev.type === 'ringing' ? 'ringing' : 'answered';
          if (!terminal && (RANK[call.status] ?? 0) < RANK[target]) {
            await c.query(`UPDATE voice_calls SET status=$2::varchar, answered_at=CASE WHEN $2::varchar='answered' THEN COALESCE(answered_at,$3::timestamptz) ELSE answered_at END, updated_at=NOW() WHERE id=$1`,
              [call.id, target, ev.occurredAt || new Date()]);
          } else if (terminal && target === 'answered' && !call.answered_at) {
            // answered arrived after hangup: record it and let settlement correct the zero-charge.
            await c.query(`UPDATE voice_calls SET answered_at=$2, status='completed', updated_at=NOW() WHERE id=$1`, [call.id, ev.occurredAt || call.ended_at]);
            const fresh = (await c.query('SELECT * FROM voice_calls WHERE id=$1', [call.id])).rows[0];
            if (fresh.settled_at) await settle(c, fresh);
          } else if (!terminal && call.answered_at == null && target === 'answered') {
            await c.query('UPDATE voice_calls SET answered_at=COALESCE(answered_at,$2) WHERE id=$1', [call.id, ev.occurredAt || new Date()]);
          }
          return { handled: true };
        }

        if (ev.type === 'hangup') {
          if (call.settled_at) return { handled: true, alreadySettled: true };
          const endedAt = ev.detail.endTime || ev.occurredAt || new Date();
          const answered = !!call.answered_at;
          const status = answered ? 'completed' : unansweredStatus(ev.detail.hangupCause);
          await c.query(
            `UPDATE voice_calls SET status=$2, ended_at=$3, started_at=COALESCE(started_at,$4), hangup_cause=$5, updated_at=NOW() WHERE id=$1`,
            [call.id, status, endedAt, ev.detail.startTime, ev.detail.hangupCause]);
          const fresh = (await c.query('SELECT * FROM voice_calls WHERE id=$1', [call.id])).rows[0];
          await settle(c, fresh);
          await audit(null, { tenantId: call.tenant_id, action: 'call.settled', entityId: call.id, detail: { status, billable: fresh.billable_seconds } });
          return { handled: true, settled: true };
        }
        return { handled: true };
      });
    },
  };
}
module.exports = { createWebhookService, unansweredStatus };
