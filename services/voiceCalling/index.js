// Wiring for CurveLead Voice (human-agent calling). Distinct from services/voice/, which is the AI-calling (Vapi) registry.
const { createCallService } = require('./calls');
const { createWebhookService } = require('./webhooks');
const { createTokenService } = require('./tokens');
const { createWalletService } = require('./wallet');
const { createRateService } = require('./rates');
const { createTopupService } = require('./topups');
const { createAdminService } = require('./admin');
const { createCountryPolicyService } = require('./countryPolicy');

let singleton;
const services = () => singleton || (singleton = {
  calls: createCallService(), webhooks: createWebhookService(), tokens: createTokenService(),
  wallet: createWalletService(), rates: createRateService(), policies: createCountryPolicyService(), topups: createTopupService(), admin: createAdminService(),
});
module.exports = { services };
