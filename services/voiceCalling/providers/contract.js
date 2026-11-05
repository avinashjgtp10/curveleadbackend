// Provider-independent contract. Providers do NOT all support the same operations, so each adapter
// declares `capabilities`; callers must check them instead of assuming.
//
// @typedef {Object} VoiceProvider
// @property {string} id
// @property {{clientToken:boolean, serverDial:boolean, hangup:boolean, callDetails:boolean, webhookVerification:boolean}} capabilities
// @property {(i:{tenantId:string,userId:string,account:Object,credentialId?:string})
//             => Promise<{token:string, credentialId:string, expiresAt:Date|null}>} createClientToken
// @property {(i:{account:Object,from:string,to:string,clientState:string,commandId:string,timeLimitSeconds:number,webhookUrl?:string})
//             => Promise<{providerCallId:string, providerSessionId:string|null}>} initiateCall
// @property {(i:{providerCallId:string, commandId?:string}) => Promise<void>} hangupCall
// @property {(providerCallId:string) => Promise<Object>} getCallDetails
// @property {(i:{rawBody:Buffer|string, headers:Object}) => VerifiedVoiceEvent} verifyWebhook  // throws on failure
//
// @typedef {Object} VerifiedVoiceEvent  normalized, provider-neutral
// @property {string} providerEventId  unique per delivery-of-the-same-event (replay key)
// @property {string} type             'initiated'|'ringing'|'answered'|'hangup'|'other'
// @property {string} rawType
// @property {Date|null} occurredAt
// @property {string|null} providerCallId
// @property {string|null} providerSessionId
// @property {string|null} clientState  base64 string we supplied at dial time
// @property {{startTime:Date|null,endTime:Date|null,hangupCause:string|null}} detail
// @property {Object} payload
const REQUIRED = ['createClientToken', 'initiateCall', 'hangupCall', 'getCallDetails', 'verifyWebhook'];
const assertProvider = (p) => {
  const missing = REQUIRED.filter((m) => typeof p[m] !== 'function');
  if (!p.id || missing.length) throw new Error(`Invalid VoiceProvider "${p.id}": missing ${missing.join(', ')}`);
  return p;
};
class ProviderError extends Error {
  // `codes` are Telnyx API error codes (never request data); `capacity` = the provider's concurrent-call limit was hit.
  constructor(message, { retryable = false, status = null, codes = [], capacity = false } = {}) {
    super(message); this.name = 'ProviderError'; this.retryable = retryable; this.status = status; this.codes = codes; this.capacity = capacity;
  }
}
module.exports = { assertProvider, ProviderError };
