// VoiceUsageService (pricing half): resolves the effective rate card. Never hardcodes prices.
const { query: defaultQuery } = require('../../config/db');
const { formatRateMicro } = require('./money');

const callTypeFor = (numberType) => (numberType === 'MOBILE' ? 'mobile' : numberType === 'FIXED_LINE' ? 'landline' : 'any');

function createRateService(deps = {}) {
  const db = deps.query || defaultQuery;
  return {
    // Longest prefix wins; then org override over platform; then call-type specific over 'any'; then newest.
    async resolveRate({ tenantId, provider, destination, currency, at = new Date() }) {
      const r = await db(
        `SELECT * FROM voice_rate_cards
         WHERE provider=$1 AND destination_country=$2 AND currency=$3
           AND (tenant_id IS NULL OR tenant_id=$4)
           AND effective_from <= $5 AND (effective_to IS NULL OR effective_to > $5)
           AND $6 LIKE destination_prefix || '%' AND call_type IN ('any',$7)
         ORDER BY length(destination_prefix) DESC, (tenant_id IS NOT NULL) DESC, (call_type <> 'any') DESC, effective_from DESC
         LIMIT 1`,
        [provider, destination.country, currency, tenantId, at, destination.digits, callTypeFor(destination.type)]);
      return r.rows[0] || null;
    },
    async listRates({ tenantId, provider, currency }) {
      const r = await db(
        `SELECT destination_country, destination_prefix, call_type, selling_price_per_minute_micro, billing_increment_seconds, currency
         FROM voice_rate_cards WHERE provider=$1 AND currency=$2 AND (tenant_id IS NULL OR tenant_id=$3)
           AND effective_from <= NOW() AND (effective_to IS NULL OR effective_to > NOW())
         ORDER BY destination_country, destination_prefix`, [provider, currency, tenantId]);
      // provider cost is internal and deliberately NOT returned to tenants
      return r.rows.map((x) => ({ ...x, display: formatRateMicro(x.selling_price_per_minute_micro, x.currency) }));
    },
  };
}
module.exports = { createRateService, callTypeFor };
