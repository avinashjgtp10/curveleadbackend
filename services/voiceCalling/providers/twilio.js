// Twilio adapter CONTRACT ONLY. Intentionally not implemented: no calls are made, nothing is faked.
// To implement: install the official `twilio` SDK, map Voice Access Tokens (client token), REST Calls
// (initiate/hangup/fetch) and X-Twilio-Signature validation onto contract.js, then register in factory.js.
const notImplemented = (op) => () => { throw new Error(`Twilio voice provider is not implemented (${op}).`); };
module.exports = {
  id: 'twilio',
  implemented: false,
  capabilities: { clientToken: false, serverDial: false, hangup: false, callDetails: false, webhookVerification: false },
  createClientToken: notImplemented('createClientToken'),
  initiateCall: notImplemented('initiateCall'),
  hangupCall: notImplemented('hangupCall'),
  getCallDetails: notImplemented('getCallDetails'),
  verifyWebhook: notImplemented('verifyWebhook'),
};
