// Registry of AI voice-calling providers. To add one (Retell, an Indian provider, …) write an
// adapter with the contract documented in ./vapi.js and register it here; nothing else changes.
const ADAPTERS = {
  vapi: require('./vapi'),
};
const DEFAULT_PROVIDER = 'vapi';

const getProvider = (id) => ADAPTERS[id || DEFAULT_PROVIDER] || null;
const providerFor = (settings) => getProvider(settings?.voice_ai_provider);
const listProviders = () => Object.values(ADAPTERS).map(({ id, label, credentials }) => ({ id, label, credentials }));

// Tests (and future plug-ins) can register an adapter without editing this file.
const registerProvider = (adapter) => { ADAPTERS[adapter.id] = adapter; };

module.exports = { DEFAULT_PROVIDER, getProvider, providerFor, listProviders, registerProvider };
