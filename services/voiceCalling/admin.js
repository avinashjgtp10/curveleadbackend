// Platform-admin (super_admin) setup of calling for an organization. Every mutation is validated and audited.
// Creating an account does NOT enable any country: routes stay off until a policy is enabled AND the
// organization's allowed_destination_countries lists the destination AND a rate card exists.
const { query: defaultQuery } = require('../../config/db');
const { normalizeDestination } = require('./phone');
const { applyMarkupBps } = require('./money');
const { audit } = require('./audit');

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const CC = /^[A-Z]{2}$/; const CUR = /^[A-Z]{3}$/;
const PROVIDERS = ['telnyx'];                      // twilio is a contract only
const intIn = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw fail(400, 'BAD_INPUT', `${name} must be an integer between ${lo} and ${hi}.`); return n; };
const bigPos = (v, name) => { try { const b = BigInt(v); if (b < 0n) throw 0; return b; } catch { throw fail(400, 'BAD_INPUT', `${name} must be a non-negative integer.`); } };

function createAdminService(deps = {}) {
  const db = deps.query || defaultQuery;
  const tenantExists = async (id) => { if (!(await db('SELECT 1 FROM tenants WHERE id=$1', [id])).rowCount) throw fail(404, 'TENANT_NOT_FOUND', 'Organization not found.'); };

  return {
    async overview(tenantId) {
      await tenantExists(tenantId);
      const [account, numbers, wallet, rates, tenant] = await Promise.all([
        db('SELECT * FROM voice_accounts WHERE tenant_id=$1', [tenantId]),
        db('SELECT id, provider, phone_number_e164, country_code, verification_status, assigned_agent_id FROM voice_phone_numbers WHERE tenant_id=$1 ORDER BY created_at', [tenantId]),
        db('SELECT currency, available_balance::text AS available_balance, reserved_balance::text AS reserved_balance FROM voice_wallets WHERE tenant_id=$1', [tenantId]),
        db(`SELECT id, tenant_id, provider, destination_country, destination_prefix, call_type, cost_per_minute_micro::text AS cost_per_minute_micro,
                   selling_price_per_minute_micro::text AS selling_price_per_minute_micro, billing_increment_seconds, currency, effective_from, effective_to
            FROM voice_rate_cards WHERE tenant_id IS NULL OR tenant_id=$1 ORDER BY destination_country, destination_prefix, effective_from DESC`, [tenantId]),
        db(`SELECT settings->>'country' AS country FROM tenants WHERE id=$1`, [tenantId]),
      ]);
      return { account: account.rows[0] || null, numbers: numbers.rows, wallets: wallet.rows, rates: rates.rows, organizationCountry: tenant.rows[0]?.country || null };
    },

    async policies() { return (await db('SELECT * FROM voice_country_policies ORDER BY origin_country, destination_country')).rows; },

    async upsertAccount({ adminId, tenantId, body }) {
      await tenantExists(tenantId);
      const provider = body.provider || 'telnyx';
      if (!PROVIDERS.includes(provider)) throw fail(400, 'BAD_INPUT', 'Unsupported provider.');
      if (body.status && !['pending', 'active', 'suspended', 'closed'].includes(body.status)) throw fail(400, 'BAD_INPUT', 'Invalid status.');
      if (body.businessVerificationStatus && !['unverified', 'pending', 'verified', 'rejected'].includes(body.businessVerificationStatus)) throw fail(400, 'BAD_INPUT', 'Invalid verification status.');
      const currency = body.defaultCurrency || 'INR'; if (!CUR.test(currency)) throw fail(400, 'BAD_INPUT', 'Invalid currency.');
      const dest = body.allowedDestinationCountries || [];
      if (!Array.isArray(dest) || !dest.every((c) => CC.test(c))) throw fail(400, 'BAD_INPUT', 'allowedDestinationCountries must be ISO alpha-2 codes.');
      const conn = body.providerAccountReference == null ? null : String(body.providerAccountReference).slice(0, 200);
      const maxCall = intIn(body.maxCallSeconds ?? 1800, 30, 14400, 'maxCallSeconds');
      const daily = intIn(body.dailyCallLimitPerAgent ?? 200, 1, 10000, 'dailyCallLimitPerAgent');
      const spend = bigPos(body.dailySpendLimitMinor ?? 0, 'dailySpendLimitMinor');
      // Activating requires a connection id; a half-configured account must not go live.
      if (body.status === 'active' && !conn) throw fail(400, 'BAD_INPUT', 'An active account needs the provider connection id.');
      const r = await db(
        `INSERT INTO voice_accounts (tenant_id, provider, provider_account_reference, status, business_verification_status, default_currency,
           allowed_destination_countries, max_call_seconds, daily_call_limit_per_agent, daily_spend_limit_minor, recording_enabled)
         VALUES ($1,$2,$3,COALESCE($4,'pending'),COALESCE($5,'unverified'),$6,$7,$8,$9,$10,false)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET provider_account_reference=EXCLUDED.provider_account_reference,
           status=COALESCE($4, voice_accounts.status), business_verification_status=COALESCE($5, voice_accounts.business_verification_status),
           default_currency=EXCLUDED.default_currency, allowed_destination_countries=EXCLUDED.allowed_destination_countries,
           max_call_seconds=EXCLUDED.max_call_seconds, daily_call_limit_per_agent=EXCLUDED.daily_call_limit_per_agent,
           daily_spend_limit_minor=EXCLUDED.daily_spend_limit_minor, updated_at=NOW() RETURNING *`,
        [tenantId, provider, conn, body.status || null, body.businessVerificationStatus || null, currency, dest, maxCall, daily, String(spend)]);
      await db('INSERT INTO voice_wallets (tenant_id, currency) VALUES ($1,$2) ON CONFLICT (tenant_id, currency) DO NOTHING', [tenantId, currency]);
      await audit(db, { tenantId, actorId: adminId, action: 'account.updated', detail: { status: r.rows[0].status, countries: dest } });
      return r.rows[0];
    },

    async addNumber({ adminId, tenantId, body }) {
      await tenantExists(tenantId);
      const n = normalizeDestination(String(body.phoneNumber || ''));
      if (!n) throw fail(400, 'BAD_INPUT', 'Enter the caller ID in international format (+…).');
      const provider = body.provider || 'telnyx'; if (!PROVIDERS.includes(provider)) throw fail(400, 'BAD_INPUT', 'Unsupported provider.');
      try {
        const r = await db(`INSERT INTO voice_phone_numbers (tenant_id, provider, phone_number_e164, country_code) VALUES ($1,$2,$3,$4) RETURNING id, phone_number_e164, country_code, verification_status`,
          [tenantId, provider, n.e164, n.country]);
        await audit(db, { tenantId, actorId: adminId, action: 'number.added', entityId: r.rows[0].id });
        return r.rows[0];
      } catch (e) { if (e.code === '23505') throw fail(409, 'DUPLICATE', 'That number is already registered.'); throw e; }
    },

    async updateNumber({ adminId, numberId, body }) {
      const cur = (await db('SELECT * FROM voice_phone_numbers WHERE id=$1', [numberId])).rows[0];
      if (!cur) throw fail(404, 'NOT_FOUND', 'Number not found.');
      if (body.verificationStatus && !['pending', 'verified', 'rejected', 'revoked'].includes(body.verificationStatus)) throw fail(400, 'BAD_INPUT', 'Invalid status.');
      if (body.assignedAgentId) { // the agent must belong to the same organization
        if (!(await db('SELECT 1 FROM users WHERE id=$1 AND tenant_id=$2', [body.assignedAgentId, cur.tenant_id])).rowCount) throw fail(400, 'BAD_INPUT', 'Agent is not in this organization.');
      }
      const r = await db(
        `UPDATE voice_phone_numbers SET verification_status=COALESCE($2, verification_status),
           verified_by=CASE WHEN $2='verified' THEN $4::uuid ELSE verified_by END, verified_at=CASE WHEN $2='verified' THEN NOW() ELSE verified_at END,
           assigned_agent_id=CASE WHEN $5::boolean THEN $3::uuid ELSE assigned_agent_id END WHERE id=$1
         RETURNING id, phone_number_e164, country_code, verification_status, assigned_agent_id`,
        [numberId, body.verificationStatus || null, body.assignedAgentId || null, adminId, Object.prototype.hasOwnProperty.call(body, 'assignedAgentId')]);
      await audit(db, { tenantId: cur.tenant_id, actorId: adminId, action: 'number.updated', entityId: numberId, detail: { status: body.verificationStatus } });
      return r.rows[0];
    },

    // Selling price is either given explicitly or derived from cost + markup (basis points). Both stored separately.
    async addRate({ adminId, body }) {
      const provider = body.provider || 'telnyx'; if (!PROVIDERS.includes(provider)) throw fail(400, 'BAD_INPUT', 'Unsupported provider.');
      if (!CC.test(body.destinationCountry || '')) throw fail(400, 'BAD_INPUT', 'destinationCountry must be ISO alpha-2.');
      if (!/^\d{1,10}$/.test(body.destinationPrefix || '')) throw fail(400, 'BAD_INPUT', 'destinationPrefix must be digits only (no +).');
      if (!CUR.test(body.currency || '')) throw fail(400, 'BAD_INPUT', 'Invalid currency.');
      if (!['any', 'mobile', 'landline'].includes(body.callType || 'any')) throw fail(400, 'BAD_INPUT', 'Invalid callType.');
      const cost = bigPos(body.costPerMinuteMicro, 'costPerMinuteMicro');
      const selling = body.sellingPricePerMinuteMicro != null ? bigPos(body.sellingPricePerMinuteMicro, 'sellingPricePerMinuteMicro')
        : applyMarkupBps(cost, intIn(body.markupBps, 0, 100000, 'markupBps'));
      if (selling < cost && body.allowBelowCost !== true) throw fail(400, 'BELOW_COST', 'Selling price is below provider cost.');
      const inc = intIn(body.billingIncrementSeconds ?? 60, 1, 600, 'billingIncrementSeconds');
      if (body.tenantId) await tenantExists(body.tenantId);
      // Close the previous rate for the same key so exactly one is effective at a time.
      await db(`UPDATE voice_rate_cards SET effective_to=NOW() WHERE provider=$1 AND destination_country=$2 AND destination_prefix=$3 AND call_type=$4 AND currency=$5
                AND COALESCE(tenant_id::text,'')=COALESCE($6::text,'') AND effective_to IS NULL`,
        [provider, body.destinationCountry, body.destinationPrefix, body.callType || 'any', body.currency, body.tenantId || null]);
      const r = await db(
        `INSERT INTO voice_rate_cards (tenant_id, provider, destination_country, destination_prefix, call_type, cost_per_minute_micro, selling_price_per_minute_micro, billing_increment_seconds, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [body.tenantId || null, provider, body.destinationCountry, body.destinationPrefix, body.callType || 'any', String(cost), String(selling), inc, body.currency]);
      await audit(db, { tenantId: body.tenantId || null, actorId: adminId, action: 'rate.added', entityId: r.rows[0].id, detail: { country: body.destinationCountry, prefix: body.destinationPrefix } });
      return { id: r.rows[0].id, sellingPricePerMinuteMicro: String(selling) };
    },
  };
}
module.exports = { createAdminService };
