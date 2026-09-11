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

module.exports = { isOptOutMessage };
