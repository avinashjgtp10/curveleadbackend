const { assertProvider } = require('./contract');
const twilio = require('./twilio');
const { createTelnyxProvider } = require('./telnyx');

// Lazy: Telnyx reads its secrets at call time, so constructing it needs no env.
const registry = { telnyx: () => createTelnyxProvider(), twilio: () => twilio };
const cache = {};

// Returns a usable provider or throws. Unimplemented providers (twilio) are never returned.
const getVoiceProvider = (id) => {
  const make = registry[id];
  if (!make) throw new Error(`Unknown voice provider "${id}".`);
  cache[id] = cache[id] || assertProvider(make());
  if (cache[id].implemented === false) throw new Error(`Voice provider "${id}" is not implemented.`);
  return cache[id];
};
const registerVoiceProvider = (provider) => { cache[provider.id] = assertProvider(provider); registry[provider.id] = () => cache[provider.id]; };
const resetVoiceProviders = () => { for (const k of Object.keys(cache)) delete cache[k]; };

module.exports = { getVoiceProvider, registerVoiceProvider, resetVoiceProviders };
