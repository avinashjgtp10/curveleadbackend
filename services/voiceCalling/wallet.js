// VoiceWalletService. All balance changes happen in a DB transaction under a row lock, with a unique
// idempotency_key per ledger entry so a replayed reserve/release/settle is a no-op.
const { transaction: defaultTransaction } = require('../../config/db');
const { big, affordableSeconds, chargeMinor } = require('./money');

const err = (status, code, message) => Object.assign(new Error(message), { status, code });

function createWalletService(deps = {}) {
  const tx = deps.transaction || defaultTransaction;
  const db = deps.query || require('../../config/db').query;

  // Inserts a ledger row; returns false when this idempotency key was already applied.
  const ledger = async (c, { tenantId, walletId, callId = null, type, amount, currency, key, reference = null }) => {
    const r = await c.query(
      `INSERT INTO voice_wallet_transactions (tenant_id, wallet_id, call_id, transaction_type, amount, currency, idempotency_key, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (wallet_id, idempotency_key) DO NOTHING RETURNING id`,
      [tenantId, walletId, callId, type, String(amount), currency, key, reference]);
    return r.rowCount === 1;
  };
  const lockWallet = async (c, tenantId, currency) => {
    const r = await c.query('SELECT * FROM voice_wallets WHERE tenant_id=$1 AND currency=$2 FOR UPDATE', [tenantId, currency]);
    return r.rows[0] || null;
  };

  return {
    ledger, lockWallet,

    async getWallet(tenantId, currency) {
      const w = (await db('SELECT id, currency, available_balance, reserved_balance, updated_at FROM voice_wallets WHERE tenant_id=$1 AND currency=$2', [tenantId, currency])).rows[0];
      return w || null;
    },
    async listTransactions(tenantId, { limit = 50, offset = 0 } = {}) {
      return (await db(
        `SELECT id, call_id, transaction_type, amount, currency, created_at FROM voice_wallet_transactions
         WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [tenantId, Math.min(limit, 200), offset])).rows;
    },

    // Reserve funds for the longest affordable duration up to `wantSeconds`. Caller supplies the open transaction
    // client so the reservation and the call row commit together.
    async reserveInTx(c, { tenantId, currency, callId, sellingRateMicro, incrementSeconds, wantSeconds, minSeconds = 60 }) {
      const w = await lockWallet(c, tenantId, currency);
      if (!w) throw err(402, 'NO_WALLET', 'No calling wallet exists for this organization.');
      const afford = affordableSeconds(w.available_balance, sellingRateMicro, incrementSeconds);
      const seconds = afford === null ? big(wantSeconds) : (afford < big(wantSeconds) ? afford : big(wantSeconds));
      if (seconds < big(minSeconds)) throw err(402, 'INSUFFICIENT_BALANCE', 'Insufficient calling balance.');
      const amount = chargeMinor(seconds, sellingRateMicro, incrementSeconds);
      await c.query('UPDATE voice_wallets SET available_balance = available_balance - $2, reserved_balance = reserved_balance + $2, updated_at=NOW() WHERE id=$1', [w.id, String(amount)]);
      await ledger(c, { tenantId, walletId: w.id, callId, type: 'reserve', amount, currency, key: `reserve:${callId}` });
      return { seconds: Number(seconds), amount };
    },

    // Give back whatever is still reserved (expired authorization, failed setup). Idempotent.
    async releaseInTx(c, { tenantId, currency, callId, amount }) {
      const a = big(amount);
      if (a === 0n) return false;
      const w = await lockWallet(c, tenantId, currency);
      if (!w) return false;
      if (!(await ledger(c, { tenantId, walletId: w.id, callId, type: 'release', amount: a, currency, key: `release:${callId}` }))) return false;
      await c.query('UPDATE voice_wallets SET available_balance = available_balance + $2, reserved_balance = reserved_balance - $2, updated_at=NOW() WHERE id=$1', [w.id, String(a)]);
      return true;
    },

    // Final settlement: drop the reservation, debit the actual charge. Returns false if already settled.
    async settleInTx(c, { tenantId, currency, callId, reservedAmount, chargeAmount }) {
      const w = await lockWallet(c, tenantId, currency);
      if (!w) throw err(500, 'NO_WALLET', 'Wallet missing at settlement.');
      const charge = big(chargeAmount); const held = big(reservedAmount);
      if (!(await ledger(c, { tenantId, walletId: w.id, callId, type: 'debit', amount: charge, currency, key: `settle:${callId}` }))) return false;
      // available gets back the hold, then pays the real charge (may go slightly negative on overage).
      await c.query('UPDATE voice_wallets SET available_balance = available_balance + $2 - $3, reserved_balance = reserved_balance - $2, updated_at=NOW() WHERE id=$1', [w.id, String(held), String(charge)]);
      return true;
    },

    // Credit only against a payment the gateway has CONFIRMED (caller passes the confirmed payment id).
    async topUp({ tenantId, currency, amountMinor, confirmedPaymentId }) {
      if (!confirmedPaymentId) throw err(400, 'PAYMENT_NOT_CONFIRMED', 'A confirmed payment id is required.');
      const amt = big(amountMinor);
      if (amt <= 0n) throw err(400, 'BAD_AMOUNT', 'Amount must be positive.');
      return tx(async (c) => {
        await c.query('INSERT INTO voice_wallets (tenant_id, currency) VALUES ($1,$2) ON CONFLICT (tenant_id, currency) DO NOTHING', [tenantId, currency]);
        const w = await lockWallet(c, tenantId, currency);
        if (!(await ledger(c, { tenantId, walletId: w.id, type: 'topup', amount: amt, currency, key: `topup:${confirmedPaymentId}`, reference: confirmedPaymentId }))) return { applied: false };
        await c.query('UPDATE voice_wallets SET available_balance = available_balance + $2, updated_at=NOW() WHERE id=$1', [w.id, String(amt)]);
        return { applied: true };
      });
    },
  };
}
module.exports = { createWalletService };
