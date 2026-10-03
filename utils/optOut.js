const OPT_OUT_PHRASES = [
  'stop', 'unsubscribe', 'remove me', 'opt out', 'optout',
  'do not contact me', 'do not message me', "don't message me",
  'stop messaging me', 'stop texting me',
];

// v1: simple, conservative keyword match — case-insensitive, punctuation-stripped.
// Exact match or substring match against a fixed phrase list.
const isOptOutMessage = (text) => {
  const normalized = (text || '').toLowerCase().trim().replace(/[.,!?]/g, '');
  if (!normalized) return false;
  return OPT_OUT_PHRASES.some((phrase) => normalized === phrase || normalized.includes(phrase));
};

// Explicit WhatsApp opt-in: the whole message is one of these keywords (not "yes", which
// usually answers some other question).
const OPT_IN_KEYWORDS = ['start', 'subscribe', 'opt in', 'optin', 'unstop'];
const isOptInMessage = (text) => OPT_IN_KEYWORDS.includes((text || '').toLowerCase().trim().replace(/[.,!?]/g, ''));

module.exports = { isOptOutMessage, isOptInMessage };
